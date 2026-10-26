import { existsSync } from 'fs';
import { commands, ExtensionContext } from 'vscode';
import { LanguageClientOptions } from 'vscode-languageclient';
import { LanguageClient } from 'vscode-languageclient/node';
import { state } from './extension';
import { cliPath } from './setupDownload';

const documentSelector = [{ scheme: 'file', language: 'Processing' }];

// ProcessingCLI's language server: errors, hover docs and go to definition
export function setupLanguageServer(context: ExtensionContext) {
	let client: LanguageClient | undefined;

	const start = async () => {
		const path = cliPath();
		if (client || !existsSync(path)) {
			return;
		}
		client = new LanguageClient('processingCli', 'ProcessingCLI Language Server', { command: path, args: ['lsp'] }, { documentSelector });
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

// Processing's own server, only used for completion now. Its errors and hovers would duplicate ours
export function setupProcessingCompletion() {
	if (!state.selectedVersion) {
		return;
	}
	const clientOptions: LanguageClientOptions = {
		documentSelector,
		middleware: {
			handleDiagnostics: () => {},
			provideHover: () => undefined,
			provideDefinition: () => undefined,
		},
	};
	state.client = new LanguageClient(
		'processingLanguageServer',
		'Processing Language Server',
		{ command: state.selectedVersion.path, args: ['lsp'] },
		clientOptions
	);
	state.client.start();
}
