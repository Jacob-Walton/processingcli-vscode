
import { ExtensionContext } from 'vscode';

import { setupCommands } from './setupCommands';
import { setupLanguageServer } from './setupLanguageServer';
import { setupSidebar } from './setupSidebar';
import { setupDecorators } from './setupDecorators';
import { setupPDEFiles } from './setupPDEFiles';
import setupConsole from './setupConsole';
import { setupDownload } from './setupDownload';
import { setupPreview } from './setupPreview';


export function activate(context: ExtensionContext) {
	// TODO: Detect other Processing extensions and warn the user
	// TODO: Override the default save-as
	// TODO: limit running sketches when a sketch is open
	// TODO: Sketch explorer context menu (right click)

	setupDownload(context);
	setupConsole(context);
	setupPreview(context);
	setupLanguageServer(context);
	setupCommands(context);
	setupSidebar(context);
	setupDecorators(context);
	setupPDEFiles();
}


export function deactivate() {}


