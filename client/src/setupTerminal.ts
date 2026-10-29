import { existsSync } from 'fs';
import { delimiter, dirname } from 'path';
import { commands, ExtensionContext, workspace } from 'vscode';
import { cliPath } from './setupDownload';

// ProcessingCLI on the PATH in VS Code's terminals
export function setupTerminal(context: ExtensionContext) {
	const update = () => {
		const env = context.environmentVariableCollection;
		env.clear();
		const path = cliPath();
		if (!workspace.getConfiguration('processing').get<boolean>('terminalPath', true) || !existsSync(path)) {
			return;
		}
		env.prepend('PATH', dirname(path) + delimiter);
	};
	update();
	context.subscriptions.push(
		workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('processing') && update()),
		commands.registerCommand('processing.terminal.update', update)
	);
}
