import { existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { commands, ConfigurationTarget, ExtensionContext, extensions, workspace } from 'vscode';
import { ExecutableOptions, LanguageClient } from 'vscode-languageclient/node';
import { cliPath } from './setupDownload';

// .java tabs too, the server ignores .java files that aren't in a sketch folder
const documentSelector = [{ scheme: 'file', language: 'Processing' }, { scheme: 'file', language: 'java' }];
// Not in the type, but passed through to spawn. Stops a console window flashing up on Windows
const options = { windowsHide: true } as unknown as ExecutableOptions;

// ProcessingCLI's language server: errors, hover docs, completion and go to definition
export function setupLanguageServer(context: ExtensionContext) {
	let client: LanguageClient | undefined;

	const start = async () => {
		const path = cliPath();
		if (client || !existsSync(path)) {
			return;
		}
		client = new LanguageClient('processingCli', 'ProcessingCLI Language Server', { command: path, args: ['lsp'], options }, { documentSelector });
		shareJar(path);
		await client.start();
	};
	const stop = async () => {
		const running = client;
		client = undefined;
		await running?.stop();
	};

	// The download replaces files the server has open, so it stops and restarts it
	context.subscriptions.push(
		commands.registerCommand('processing.lsp.start', start),
		commands.registerCommand('processing.lsp.stop', stop),
		{ dispose: stop }
	);
	start();
}

// Points the Java extension at ProcessingCLI's jar, so it can resolve processing.core in .java tabs
async function shareJar(cli: string) {
	if (!extensions.getExtension('redhat.java')) {
		return;
	}
	// Where jpackage puts it on Windows, macOS and Linux
	const dir = [join(dirname(cli), 'app'), join(dirname(cli), '..', 'app'), join(dirname(cli), '..', 'lib', 'app')].find(existsSync);
	const jar = dir && readdirSync(dir).find((file) => file.endsWith('-all.jar'));
	const config = workspace.getConfiguration('java.project');
	const inspected = config.inspect<string[]>('referencedLibraries');
	const current = inspected?.globalValue ?? inspected?.defaultValue;
	// It can also be an object with include and exclude lists, leave that alone
	if (!dir || !jar || !Array.isArray(current)) {
		return;
	}
	const path = join(dir, jar);
	// Drops the jar from older versions
	const others = current.filter((entry) => !entry.includes('ProcessingCLI'));
	if (current.length !== others.length + 1 || !current.includes(path)) {
		await config.update('referencedLibraries', [...others, path], ConfigurationTarget.Global);
	}
}
