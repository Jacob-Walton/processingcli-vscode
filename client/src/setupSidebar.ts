import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { EventEmitter, ExtensionContext, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri, window, workspace } from 'vscode';
import { ensureExamples } from './setupDownload';

export function setupSidebar(context: ExtensionContext) {
	const sketchbook = new SketchTree(() => folders(sketchbookDir()), false);
	const examples = new SketchTree(async () => {
		const core = await ensureExamples();
		// Libraries keep theirs in libraries/<name>/examples
		const libraries = folders(join(sketchbookDir(), 'libraries'), true).map((lib) => join(lib, 'examples'));
		return [...(core ? folders(core) : []), ...libraries.filter(existsSync)];
	}, true);

	const sketchbookView = window.createTreeView('processingSidebarSketchbookView', { treeDataProvider: sketchbook });
	const examplesView = window.createTreeView('processingSidebarExamplesView', { treeDataProvider: examples });
	// Sketches made outside VS Code
	sketchbookView.onDidChangeVisibility((e) => e.visible && sketchbook.refresh());
	context.subscriptions.push(sketchbookView, examplesView);
}

// Setting, then Processing's preference, then its default
export function sketchbookDir() {
	const configured = workspace.getConfiguration('processing').get<string>('sketchbook', '');
	if (configured) {
		return configured;
	}
	const preferences = process.platform === 'win32'
		? join(process.env.APPDATA ?? '', 'Processing', 'preferences.txt')
		: process.platform === 'darwin'
			? join(homedir(), 'Library', 'Processing', 'preferences.txt')
			: join(homedir(), '.config', 'processing', 'preferences.txt');
	try {
		const path = /^sketchbook\.path\.four=(.+)$/m.exec(readFileSync(preferences, 'utf8'))?.[1].trim();
		if (path) {
			return path;
		}
	} catch {
		// Processing has never run here
	}
	if (process.platform === 'linux') {
		return join(homedir(), 'sketchbook');
	}
	// Windows often moves Documents into OneDrive
	const documents = [process.env.OneDrive ? join(process.env.OneDrive, 'Documents') : '', join(homedir(), 'Documents')];
	return join(documents.find((d) => d && existsSync(join(d, 'Processing'))) ?? join(homedir(), 'Documents'), 'Processing');
}

// In the sketchbook but not sketches
const SKIPPED = new Set(['libraries', 'modes', 'tools', 'templates']);

function folders(dir: string, all = false) {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith('.') && (all || !SKIPPED.has(e.name)))
			.map((e) => join(dir, e.name));
	} catch {
		return [];
	}
}

function isSketch(dir: string) {
	return existsSync(join(dir, `${basename(dir)}.pde`));
}

function containsSketch(dir: string, depth: number): boolean {
	return isSketch(dir) || (depth > 0 && folders(dir).some((d) => containsSketch(d, depth - 1)));
}

// Folder paths, sketches first
class SketchTree implements TreeDataProvider<string> {
	private readonly changed = new EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;

	constructor(private readonly roots: () => string[] | Promise<string[]>, private readonly readonly: boolean) {}

	refresh() {
		this.changed.fire();
	}

	async getChildren(dir?: string) {
		const dirs = dir ? folders(dir) : await this.roots();
		return dirs
			.filter((d) => containsSketch(d, 3))
			.sort((a, b) => Number(isSketch(b)) - Number(isSketch(a)) || label(a).localeCompare(label(b)));
	}

	getTreeItem(dir: string) {
		if (!isSketch(dir)) {
			return new TreeItem(label(dir), TreeItemCollapsibleState.Collapsed);
		}
		const item = new TreeItem(label(dir), TreeItemCollapsibleState.None);
		item.tooltip = dir;
		const preview = join(dir, `${basename(dir)}.png`);
		item.iconPath = Uri.file(existsSync(preview) ? preview : join(__dirname, '..', '..', 'media', 'processing-flat-color.svg'));
		item.command = { command: 'processing.sketch.open', title: 'Open Sketch', arguments: [dir, this.readonly] };
		return item;
	}
}

// Named after the library
function label(dir: string) {
	return basename(dir) === 'examples' ? basename(dirname(dir)) : basename(dir);
}
