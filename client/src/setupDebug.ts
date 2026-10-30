import { ChildProcess, spawn } from 'child_process';
import { basename, dirname } from 'path';
import {
	commands,
	debug,
	DebugAdapter,
	DebugAdapterInlineImplementation,
	DebugConfiguration,
	DebugProtocolMessage,
	Event,
	EventEmitter,
	ExtensionContext,
	Uri,
	window,
	workspace,
} from 'vscode';
import { killTree } from './killTree';
import { cleanEnv } from './setupConsole';
import { ensureCli } from './setupDownload';
import { sketchbookDir } from './setupSidebar';

// Breakpoints, stepping and variables through "ProcessingCLI debug"
export function setupDebug(context: ExtensionContext) {
	context.subscriptions.push(
		debug.registerDebugAdapterDescriptorFactory('processing', {
			async createDebugAdapterDescriptor() {
				const path = await ensureCli();
				return path ? new DebugAdapterInlineImplementation(new Adapter(path)) : undefined;
			},
		}),
		// F5 without a launch.json debugs the open sketch
		debug.registerDebugConfigurationProvider('processing', {
			resolveDebugConfiguration(_folder, config: DebugConfiguration) {
				const file = window.activeTextEditor?.document.uri.fsPath;
				if (!config.type && !file) {
					return undefined;
				}
				if (!config.type) {
					return launch(file as string);
				}
				config.sketch ??= file && dirname(file);
				return config;
			},
		}),
		commands.registerCommand('processing.sketch.debug', async (resource?: Uri) => {
			const file = (resource ?? window.activeTextEditor?.document.uri)?.fsPath;
			if (!file) {
				return;
			}
			await workspace.saveAll(false);
			debug.startDebugging(workspace.getWorkspaceFolder(Uri.file(file)), launch(file));
		})
	);
}

function launch(file: string): DebugConfiguration {
	const sketch = dirname(file);
	return { type: 'processing', request: 'launch', name: `Debug ${basename(sketch)}`, sketch };
}

// Spawned here rather than by VS Code, so no console window flashes up on Windows
class Adapter implements DebugAdapter {
	private readonly sent = new EventEmitter<DebugProtocolMessage>();
	readonly onDidSendMessage: Event<DebugProtocolMessage> = this.sent.event;
	private readonly proc: ChildProcess;
	private buffer = Buffer.alloc(0);

	constructor(path: string) {
		this.proc = spawn(path, ['debug'], { windowsHide: true, env: { ...cleanEnv(), PCLI_SKETCHBOOK: sketchbookDir() } });
		this.proc.stdout?.on('data', (data: Buffer) => this.read(data));
	}

	// Content-Length framed JSON
	private read(data: Buffer) {
		this.buffer = Buffer.concat([this.buffer, data]);
		for (;;) {
			const end = this.buffer.indexOf('\r\n\r\n');
			if (end < 0) {
				return;
			}
			const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1]);
			if (this.buffer.length < end + 4 + length) {
				return;
			}
			this.sent.fire(JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString()));
			this.buffer = this.buffer.subarray(end + 4 + length);
		}
	}

	handleMessage(message: DebugProtocolMessage) {
		const json = JSON.stringify(message);
		this.proc.stdin?.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
	}

	dispose() {
		if (this.proc.pid && this.proc.exitCode === null) {
			killTree(this.proc.pid);
		}
	}
}
