import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { IncomingMessage } from 'http';
import { get } from 'https';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { commands, ConfigurationTarget, ExtensionContext, ProgressLocation, window, workspace } from 'vscode';

// latest.json lists the current version's zip and checksum for each platform
const DOWNLOAD_URL = 'https://cdn.konpeki.co.uk/processingcli';

const platforms: Record<string, { name: string, executable: string[] }> = {
	win32: { name: 'windows', executable: ['ProcessingCLI', 'ProcessingCLI.exe'] },
	darwin: { name: 'macos', executable: ['ProcessingCLI.app', 'Contents', 'MacOS', 'ProcessingCLI'] },
};

interface Manifest {
	version: string;
	files: Record<string, { url: string, sha256: string }>;
}

export function setupDownload(context: ExtensionContext) {
	const download = commands.registerCommand('processing.cli.download', async () => {
		const platform = platforms[process.platform];
		if (!platform) {
			window.showErrorMessage(`ProcessingCLI is not available for ${process.platform}.`);
			return;
		}
		const target = `${platform.name}-${process.arch}`;
		const storage = context.globalStorageUri.fsPath;
		const zipPath = join(storage, `ProcessingCLI-${target}.zip`);
		const installDir = join(storage, 'ProcessingCLI');
		let version = '';

		// Running sketches lock the old files on Windows
		await commands.executeCommand('processing.sketch.stop');

		try {
			await window.withProgress({ location: ProgressLocation.Notification, title: 'Downloading ProcessingCLI' }, async (progress) => {
				await mkdir(storage, { recursive: true });
				const manifest: Manifest = JSON.parse(await fetchText(`${DOWNLOAD_URL}/latest.json?t=${Date.now()}`));
				const file = manifest.files[target];
				if (!file) {
					throw new Error(`no download for ${target}`);
				}
				version = manifest.version;
				const actual = await downloadFile(`${DOWNLOAD_URL}/${file.url}`, zipPath, (percent) => progress.report({ increment: percent }));
				if (actual !== file.sha256.toLowerCase()) {
					throw new Error(`checksum mismatch for ${file.url}`);
				}
				progress.report({ message: 'Extracting' });
				await rm(installDir, { recursive: true, force: true });
				await mkdir(installDir, { recursive: true });
				await unzip(zipPath, installDir);
			});
		} catch (error) {
			window.showErrorMessage(`Could not download ProcessingCLI: ${error instanceof Error ? error.message : error}`);
			return;
		} finally {
			await rm(zipPath, { force: true });
		}

		const cliPath = join(installDir, ...platform.executable);
		await workspace.getConfiguration('processing').update('cliPath', cliPath, ConfigurationTarget.Global);
		window.showInformationMessage(`ProcessingCLI ${version} installed to ${cliPath}`);
	});

	context.subscriptions.push(download);
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

function unzip(zip: string, dest: string) {
	const [command, args] = process.platform === 'win32'
		? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest]]
		: ['/usr/bin/ditto', ['-x', '-k', zip, dest]];
	return new Promise<void>((resolve, reject) => {
		execFile(command, args, (error) => error ? reject(error) : resolve());
	});
}
