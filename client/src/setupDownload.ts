import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, readFileSync } from 'fs';
import { mkdir, readdir, rename, rm, writeFile } from 'fs/promises';
import { IncomingMessage } from 'http';
import { get } from 'https';
import { basename, isAbsolute, join } from 'path';
import { pipeline } from 'stream/promises';
import { commands, ConfigurationTarget, ExtensionContext, ProgressLocation, window, workspace } from 'vscode';

// latest.json lists the current version's zip and checksum for each platform
const DOWNLOAD_URL = 'https://cdn.konpeki.co.uk/processingcli';

const platforms: Record<string, { name: string, executable: string[] }> = {
	win32: { name: 'windows', executable: ['ProcessingCLI', 'ProcessingCLI.exe'] },
	darwin: { name: 'macos', executable: ['ProcessingCLI.app', 'Contents', 'MacOS', 'ProcessingCLI'] },
	linux: { name: 'linux', executable: ['ProcessingCLI', 'bin', 'ProcessingCLI'] },
};

interface Manifest {
	version: string;
	files: Record<string, { url: string, sha256: string }>;
}

let installRoot = '';
let oldInstallRoot = '';
let downloading: Promise<boolean> | undefined;

function appDir() {
	return join(installRoot, 'app');
}

// No current file means the layout from before versioned installs, app/ProcessingCLI
function currentVersion() {
	try {
		return readFileSync(join(appDir(), 'current'), 'utf8').trim();
	} catch {
		return '';
	}
}

function executable(version: string) {
	const platform = platforms[process.platform];
	return platform ? join(appDir(), version, ...platform.executable) : '';
}

// 1.0.0 saved its download location in the setting, that copy can't run the language server
function configuredPath() {
	const configured = workspace.getConfiguration('processing').get<string>('cliPath', '');
	return configured.toLowerCase().startsWith(oldInstallRoot.toLowerCase()) ? '' : configured;
}

// The user's own ProcessingCLI if they set one, otherwise the downloaded one
export function cliPath() {
	return configuredPath() || executable(currentVersion());
}

// Downloads ProcessingCLI the first time it's needed
export async function ensureCli(): Promise<string | undefined> {
	const path = cliPath();
	if (isAbsolute(path) && existsSync(path)) {
		return path;
	}
	if (configuredPath()) {
		window.showErrorMessage(`ProcessingCLI not found at ${path}. Fix processing.cliPath, or clear it to use the downloaded one.`, 'Open Settings')
			.then((choice) => choice && commands.executeCommand('workbench.action.openSettings', 'processing.cliPath'));
		return undefined;
	}
	return (await download()) ? cliPath() : undefined;
}

// Shared so Run and the language server starting at the same time only download once
function download() {
	downloading ??= install().finally(() => {
		downloading = undefined;
	});
	return downloading;
}

export function setupDownload(context: ExtensionContext) {
	installRoot = join(process.env.LOCALAPPDATA ?? context.globalStorageUri.fsPath, 'ProcessingCLI');
	oldInstallRoot = join(context.globalStorageUri.fsPath, 'ProcessingCLI');

	const configured = workspace.getConfiguration('processing').get<string>('cliPath', '');
	if (configured && !configuredPath()) {
		workspace.getConfiguration('processing').update('cliPath', undefined, ConfigurationTarget.Global);
	}

	const command = commands.registerCommand('processing.cli.download', download);
	context.subscriptions.push(command);
}

async function install(): Promise<boolean> {
	const platform = platforms[process.platform];
	if (!platform) {
		window.showErrorMessage(`ProcessingCLI is not available for ${process.platform}.`);
		return false;
	}
	const target = `${platform.name}-${process.arch}`;
	let archive = '';
	let partial = '';
	let version = '';

	try {
		const installed = await window.withProgress({ location: ProgressLocation.Notification, title: 'Downloading ProcessingCLI' }, async (progress) => {
			await mkdir(appDir(), { recursive: true });
			const manifest: Manifest = JSON.parse(await fetchText(`${DOWNLOAD_URL}/latest.json?t=${Date.now()}`));
			const file = manifest.files[target];
			if (!file) {
				throw new Error(`no download for ${target}`);
			}
			version = manifest.version;
			if (existsSync(executable(version))) {
				if (currentVersion() === version) {
					return false;
				}
				// Another window already downloaded it
				await writeFile(join(appDir(), 'current'), version);
				return true;
			}

			// Per process names, another VS Code window may be downloading at the same time
			archive = join(installRoot, `${process.pid}-${basename(file.url)}`);
			const actual = await downloadFile(`${DOWNLOAD_URL}/${file.url}`, archive, (percent) => progress.report({ increment: percent }));
			if (actual !== file.sha256.toLowerCase()) {
				throw new Error(`checksum mismatch for ${file.url}`);
			}
			progress.report({ message: 'Extracting' });
			partial = join(appDir(), `${version}.${process.pid}.partial`);
			await rm(partial, { recursive: true, force: true });
			await mkdir(partial, { recursive: true });
			await unpack(archive, partial);
			// Renamed into place once complete, unless another window got there first
			if (!existsSync(executable(version))) {
				await rm(join(appDir(), version), { recursive: true, force: true });
				await rename(partial, join(appDir(), version));
			}
			await writeFile(join(appDir(), 'current'), version);
			return true;
		});
		if (!installed) {
			window.showInformationMessage(`ProcessingCLI ${version} is already the latest version.`);
			return true;
		}
	} catch (error) {
		window.showErrorMessage(`Could not download ProcessingCLI: ${error instanceof Error ? error.message : error}`);
		return false;
	} finally {
		for (const leftover of [archive, partial]) {
			if (leftover) {
				await rm(leftover, { recursive: true, force: true });
			}
		}
	}

	// Switch this window's language server to the new version, then clear out old ones nothing is using
	await commands.executeCommand('processing.lsp.stop');
	await commands.executeCommand('processing.lsp.start');
	await removeOldVersions(version);

	window.showInformationMessage(`ProcessingCLI ${version} installed.`);
	return true;
}

// Versions still in use by a sketch or another window fail to delete, they go on a later update
async function removeOldVersions(keep: string) {
	for (const entry of await readdir(appDir())) {
		if (entry !== keep && entry !== 'current' && !entry.endsWith('.partial')) {
			await rm(join(appDir(), entry), { recursive: true, force: true }).catch(() => {});
		}
	}
}

function request(url: string, redirects = 5): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		get(url, (res) => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
				res.resume();
				resolve(request(new URL(res.headers.location, url).toString(), redirects - 1));
			} else if (status !== 200) {
				res.resume();
				reject(new Error(`${url} returned ${status}`));
			} else {
				resolve(res);
			}
		}).on('error', reject);
	});
}

async function fetchText(url: string) {
	let text = '';
	for await (const chunk of await request(url)) {
		text += chunk;
	}
	return text;
}

async function downloadFile(url: string, dest: string, onProgress: (percent: number) => void) {
	const res = await request(url);
	const total = Number(res.headers['content-length']) || 0;
	const hash = createHash('sha256');
	res.on('data', (chunk: Buffer) => {
		hash.update(chunk);
		if (total) {
			onProgress(chunk.length / total * 100);
		}
	});
	await pipeline(res, createWriteStream(dest));
	return hash.digest('hex');
}

// Tools every install of each OS has, by absolute path
function unpack(archive: string, dest: string) {
	const [command, args] = process.platform === 'win32'
		? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', dest]]
		: process.platform === 'darwin'
			? ['/usr/bin/ditto', ['-x', '-k', archive, dest]]
			: [existsSync('/usr/bin/tar') ? '/usr/bin/tar' : '/bin/tar', ['-xzf', archive, '-C', dest]];
	return new Promise<void>((resolve, reject) => {
		execFile(command, args, (error) => error ? reject(error) : resolve());
	});
}
