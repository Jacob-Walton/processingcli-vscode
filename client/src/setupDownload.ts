import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, existsSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
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

// LOCALAPPDATA rather than VS Code's storage, which is in the roaming profile on Windows
function installDir() {
	return join(installRoot, 'app');
}

// 1.0.0 saved its download location in the setting, that copy can't run the language server
function configuredPath() {
	const configured = workspace.getConfiguration('processing').get<string>('cliPath', '');
	return configured.toLowerCase().startsWith(oldInstallRoot.toLowerCase()) ? '' : configured;
}

// The user's own ProcessingCLI if they set one, otherwise the downloaded one
export function cliPath() {
	const platform = platforms[process.platform];
	return configuredPath() || (platform ? join(installDir(), ...platform.executable) : '');
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
	let version = '';

	// Windows won't replace files a running sketch or the language server has open
	await commands.executeCommand('processing.sketch.stop');
	await commands.executeCommand('processing.lsp.stop');

	try {
		await window.withProgress({ location: ProgressLocation.Notification, title: 'Downloading ProcessingCLI' }, async (progress) => {
			await mkdir(installRoot, { recursive: true });
			const manifest: Manifest = JSON.parse(await fetchText(`${DOWNLOAD_URL}/latest.json?t=${Date.now()}`));
			const file = manifest.files[target];
			if (!file) {
				throw new Error(`no download for ${target}`);
			}
			version = manifest.version;
			// .zip, or .tar.gz on Linux
			archive = join(installRoot, basename(file.url));
			const actual = await downloadFile(`${DOWNLOAD_URL}/${file.url}`, archive, (percent) => progress.report({ increment: percent }));
			if (actual !== file.sha256.toLowerCase()) {
				throw new Error(`checksum mismatch for ${file.url}`);
			}
			progress.report({ message: 'Extracting' });
			await rm(installDir(), { recursive: true, force: true });
			await mkdir(installDir(), { recursive: true });
			await unpack(archive, installDir());
		});
	} catch (error) {
		window.showErrorMessage(`Could not download ProcessingCLI: ${error instanceof Error ? error.message : error}`);
		return false;
	} finally {
		if (archive) {
			await rm(archive, { force: true });
		}
		await commands.executeCommand('processing.lsp.start');
	}

	window.showInformationMessage(`ProcessingCLI ${version} installed.`);
	return true;
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
