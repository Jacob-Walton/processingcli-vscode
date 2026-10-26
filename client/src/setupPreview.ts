import { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { AddressInfo, createServer } from 'net';
import { basename, dirname } from 'path';
import * as treeKill from 'tree-kill';
import { commands, ExtensionContext, Uri, ViewColumn, WebviewPanel, window, workspace } from 'vscode';

export function setupPreview(context: ExtensionContext) {
	let panel: WebviewPanel | undefined;
	let sketchFile: Uri | undefined;
	let current: ChildProcess | undefined;
	let restart: NodeJS.Timeout | undefined;
	// ProcessingCLI serves frames on this port, the webview connects to it directly
	let address = '';

	const start = async () => {
		if (!panel || !sketchFile) {
			return;
		}
		panel.webview.postMessage({ type: 'start' });
		// The new ProcessingCLI binds the same port, so the old one has to be gone first
		const previous = current;
		current = undefined;
		if (previous?.pid && previous.exitCode === null) {
			await Promise.all([
				new Promise((resolve) => previous.once('exit', resolve)),
				new Promise((resolve) => treeKill(previous.pid as number, 'SIGKILL', resolve)),
			]);
		}
		const proc = await commands.executeCommand<ChildProcess | undefined>('processing.sketch.run', sketchFile, undefined, address);
		current = proc;
		if (!proc) {
			return;
		}
		const log = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
			if (proc === current) {
				panel?.webview.postMessage({ type: 'log', stream, value: data.toString() });
			}
		};
		proc.stdout?.on('data', log('stdout'));
		proc.stderr?.on('data', log('stderr'));
		proc.on('close', (code) => {
			if (proc === current) {
				panel?.webview.postMessage({ type: 'stopped', error: !!code });
			}
		});
	};

	const preview = commands.registerCommand('processing.sketch.preview', async (resource?: Uri) => {
		resource ??= window.activeTextEditor?.document.uri;
		if (!resource) {
			return;
		}
		sketchFile = resource;
		if (panel) {
			panel.reveal(undefined, true);
		} else {
			const port = await freePort();
			const token = randomBytes(16).toString('hex');
			address = `${port}/${token}`;
			panel = window.createWebviewPanel(
				'processingPreview',
				'',
				{ viewColumn: ViewColumn.Beside, preserveFocus: true },
				{ enableScripts: true, retainContextWhenHidden: true }
			);
			panel.webview.html = previewHtml(randomBytes(16).toString('base64'), port, token);
			panel.onDidDispose(() => {
				panel = undefined;
				if (current?.pid) {
					treeKill(current.pid);
				}
				current = undefined;
			});
		}
		panel.title = `Preview ${basename(dirname(resource.fsPath))}`;
		await workspace.saveAll(false);
		await start();
	});

	const onSave = workspace.onDidSaveTextDocument((document) => {
		if (!panel || !sketchFile || !/\.(pde|java)$/.test(document.fileName)) {
			return;
		}
		if (dirname(document.fileName) !== dirname(sketchFile.fsPath)) {
			return;
		}
		// Save All saves several files at once, restart once
		clearTimeout(restart);
		restart = setTimeout(start, 100);
	});

	context.subscriptions.push(preview, onSave);
}

function freePort() {
	return new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

function previewHtml(nonce: string, port: number, token: string) {
	return `<!DOCTYPE html>
<html>
	<head>
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ws://127.0.0.1:${port};">
		<style>
			html, body {
				height: 100%;
				margin: 0;
				overflow: hidden;
			}

			body {
				display: flex;
				flex-direction: column;
				background-color: var(--vscode-editor-background);
				color: var(--vscode-descriptionForeground);
				font-family: var(--vscode-font-family);
			}

			#stage {
				flex: 1;
				min-height: 0;
				display: flex;
				align-items: center;
				justify-content: center;
				position: relative;
			}

			canvas {
				outline: none;
			}

			#status {
				position: absolute;
				left: 8px;
				bottom: 8px;
			}

			#log {
				max-height: 30%;
				overflow: auto;
				margin: 0;
				padding: 4px 8px;
				border-top: 1px solid var(--vscode-panel-border);
				font-family: var(--vscode-editor-font-family);
				font-size: var(--vscode-editor-font-size);
				color: var(--vscode-editor-foreground);
				white-space: pre-wrap;
				word-break: break-word;
			}

			#log:empty {
				display: none;
			}

			.stderr {
				color: var(--vscode-editorError-foreground);
			}
		</style>
	</head>
	<body>
		<div id="stage">
			<canvas tabindex="0"></canvas>
			<div id="status">Starting…</div>
		</div>
		<pre id="log"></pre>
		<script nonce="${nonce}">
			const canvas = document.querySelector('canvas');
			const status = document.getElementById('status');
			const log = document.getElementById('log');
			const stage = document.getElementById('stage');

			// Same values as processing.event and PConstants
			const PRESS = 1, RELEASE = 2, CLICK = 3, DRAG = 4, MOVE = 5, ENTER = 6, EXIT = 7, WHEEL = 8, TYPE = 3;
			const BUTTONS = [37, 3, 39];
			const CODED = 0xFFFF;

			let socket;
			let width = 0;
			let height = 0;
			let pending;
			let pressed = 0;

			// Frames are ARGB ints, so the bytes are BGRA, swap them back in the shader
			const gl = canvas.getContext('webgl', { alpha: false, antialias: false, desynchronized: true });
			const shader = (type, source) => {
				const s = gl.createShader(type);
				gl.shaderSource(s, source);
				gl.compileShader(s);
				return s;
			};
			const program = gl.createProgram();
			gl.attachShader(program, shader(gl.VERTEX_SHADER,
				'attribute vec2 p; varying vec2 uv; void main() { uv = vec2(p.x, -p.y) * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }'));
			gl.attachShader(program, shader(gl.FRAGMENT_SHADER,
				'precision mediump float; uniform sampler2D t; varying vec2 uv; void main() { gl_FragColor = vec4(texture2D(t, uv).bgr, 1.0); }'));
			gl.linkProgram(program);
			gl.useProgram(program);
			gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
			gl.enableVertexAttribArray(0);
			gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
			gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

			// Fit the sketch in the panel, never scaled up
			const fit = () => {
				const scale = Math.min(1, stage.clientWidth / width, stage.clientHeight / height);
				canvas.style.width = width * scale + 'px';
				canvas.style.height = height * scale + 'px';
			};
			new ResizeObserver(() => width && fit()).observe(stage);

			// Only draw the newest frame, once per display refresh
			const draw = () => {
				requestAnimationFrame(draw);
				if (!pending) {
					return;
				}
				const frame = new DataView(pending);
				const pixelWidth = frame.getInt32(0, true), pixelHeight = frame.getInt32(4, true);
				const pixels = new Uint8Array(pending, 16, pixelWidth * pixelHeight * 4);
				if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
					canvas.width = pixelWidth;
					canvas.height = pixelHeight;
					gl.viewport(0, 0, pixelWidth, pixelHeight);
					gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, pixelWidth, pixelHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
				} else {
					gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pixelWidth, pixelHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
				}
				if (width !== frame.getInt32(8, true) || height !== frame.getInt32(12, true)) {
					width = frame.getInt32(8, true);
					height = frame.getInt32(12, true);
					fit();
				}
				gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
				pending = undefined;
				status.textContent = '';
			};
			requestAnimationFrame(draw);

			// Keeps trying, ProcessingCLI opens the port once the sketch has compiled
			const connect = () => {
				socket = new WebSocket('ws://127.0.0.1:${port}/${token}');
				socket.binaryType = 'arraybuffer';
				socket.onmessage = (e) => { pending = e.data; };
				socket.onerror = () => {};
				socket.onclose = () => setTimeout(connect, 100);
			};
			connect();

			addEventListener('message', ({ data: message }) => {
				if (message.type === 'start') {
					status.textContent = 'Starting…';
					log.textContent = '';
				} else if (message.type === 'stopped') {
					status.textContent = message.error ? 'Sketch stopped with an error. Save to try again.' : 'Sketch stopped. Save to restart.';
				} else if (message.type === 'log') {
					const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
					const span = document.createElement('span');
					span.className = message.stream;
					span.textContent = message.value;
					log.appendChild(span);
					if (atBottom) {
						log.scrollTop = log.scrollHeight;
					}
				}
			});

			const send = (buffer) => {
				if (socket && socket.readyState === WebSocket.OPEN) {
					socket.send(buffer);
				}
			};
			const modifiers = (e) => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.altKey ? 8 : 0);

			const mouse = (action, e, button = pressed, count = 0) => {
				const rect = canvas.getBoundingClientRect();
				const view = new DataView(new ArrayBuffer(22));
				view.setUint8(0, 77);
				view.setInt8(1, action);
				view.setInt32(2, Math.round((e.clientX - rect.left) * width / rect.width));
				view.setInt32(6, Math.round((e.clientY - rect.top) * height / rect.height));
				view.setInt32(10, button);
				view.setInt32(14, count);
				view.setInt32(18, modifiers(e));
				send(view.buffer);
			};

			canvas.addEventListener('mousedown', (e) => {
				canvas.focus();
				pressed = BUTTONS[e.button] ?? 37;
				mouse(PRESS, e, pressed, 1);
			});
			addEventListener('mouseup', (e) => {
				if (pressed) {
					mouse(RELEASE, e, pressed, 1);
					pressed = 0;
				}
			});
			canvas.addEventListener('click', (e) => mouse(CLICK, e, BUTTONS[e.button] ?? 37, e.detail));
			canvas.addEventListener('mousemove', (e) => mouse(pressed ? DRAG : MOVE, e));
			canvas.addEventListener('mouseenter', (e) => mouse(ENTER, e));
			canvas.addEventListener('mouseleave', (e) => mouse(EXIT, e));
			canvas.addEventListener('wheel', (e) => {
				e.preventDefault();
				mouse(WHEEL, e, 0, Math.sign(e.deltaY));
			}, { passive: false });
			canvas.addEventListener('contextmenu', (e) => e.preventDefault());

			const keyOf = (e) => e.key.length === 1
				? e.key.charCodeAt(0)
				: ({ Enter: 10, Backspace: 8, Tab: 9, Escape: 27, Delete: 127 })[e.key] ?? CODED;
			// Browser key codes that differ from Java's
			const keyCodeOf = (e) => ({ 13: 10, 46: 127 })[e.keyCode] ?? e.keyCode;

			const key = (action, e) => {
				const view = new DataView(new ArrayBuffer(12));
				view.setUint8(0, 75);
				view.setInt8(1, action);
				view.setUint16(2, keyOf(e));
				view.setInt32(4, keyCodeOf(e));
				view.setInt32(8, modifiers(e));
				send(view.buffer);
			};

			// Leave Ctrl/Cmd shortcuts to VS Code
			canvas.addEventListener('keydown', (e) => {
				if (e.ctrlKey || e.metaKey) {
					return;
				}
				e.preventDefault();
				key(PRESS, e);
				if (keyOf(e) !== CODED) {
					key(TYPE, e);
				}
			});
			canvas.addEventListener('keyup', (e) => {
				if (!e.ctrlKey && !e.metaKey) {
					key(RELEASE, e);
				}
			});
		</script>
	</body>
</html>`;
}
