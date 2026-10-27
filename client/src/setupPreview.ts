import { ChildProcess, execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { AddressInfo, createServer } from 'net';
import { basename, dirname } from 'path';
import { killTree } from './killTree';
import { commands, ExtensionContext, Uri, ViewColumn, WebviewPanel, window, workspace } from 'vscode';
import { cliPath } from './setupDownload';

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
				killTree(previous.pid),
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
			if (proc !== current) {
				return;
			}
			// 75: the old sketch wouldn't stop for a reload, so start a fresh ProcessingCLI
			if (code === 75) {
				start();
			} else {
				panel?.webview.postMessage({ type: 'stopped', error: !!code });
			}
		});
	};

	// Newer ProcessingCLIs reload the sketch in the same JVM, much faster than starting a new one
	const reload = async () => {
		const proc = current;
		if (panel && proc?.stdin?.writable && proc.exitCode === null && await supportsReload(cliPath())) {
			panel.webview.postMessage({ type: 'start' });
			proc.stdin.write('reload\n');
			return;
		}
		await start();
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
					killTree(current.pid);
				}
				current = undefined;
			});
		}
		panel.title = `Preview ${basename(dirname(resource.fsPath))}`;
		await workspace.saveAll(false);
		await reload();
	});

	const onSave = workspace.onDidSaveTextDocument((document) => {
		if (!panel || !sketchFile || !/\.(pde|java)$/.test(document.fileName)) {
			return;
		}
		if (dirname(document.fileName) !== dirname(sketchFile.fsPath)) {
			return;
		}
		// Save All saves several files at once, reload once
		clearTimeout(restart);
		restart = setTimeout(reload, 100);
	});

	const toggleStats = commands.registerCommand('processing.preview.stats', () => panel?.webview.postMessage({ type: 'stats' }));

	context.subscriptions.push(preview, onSave, toggleStats);
}

const reloadSupport = new Map<string, Promise<boolean>>();

// In-place reloads came in ProcessingCLI 1.2.0, local builds say "dev"
function supportsReload(path: string) {
	let supported = reloadSupport.get(path);
	if (!supported) {
		supported = new Promise((resolve) => {
			execFile(path, ['--version'], { windowsHide: true }, (error, stdout) => {
				const version = /ProcessingCLI (\S+)/.exec(stdout)?.[1] ?? '';
				const [major, minor] = version.split('.').map(Number);
				resolve(!error && (version === 'dev' || major > 1 || (major === 1 && minor >= 2)));
			});
		});
		reloadSupport.set(path, supported);
	}
	return supported;
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

			#overlay {
				position: absolute;
				inset: 0;
				display: flex;
				flex-direction: column;
				align-items: center;
				justify-content: center;
				gap: 12px;
				padding: 16px;
				text-align: center;
			}

			#overlay[hidden] {
				display: none;
			}

			.spinner {
				width: 24px;
				height: 24px;
				border: 3px solid var(--vscode-progressBar-background);
				border-top-color: transparent;
				border-radius: 50%;
				animation: spin 0.8s linear infinite;
			}

			#overlay:not(.busy) .spinner {
				display: none;
			}

			@keyframes spin {
				to {
					transform: rotate(360deg);
				}
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

			#stats {
				position: absolute;
				top: 4px;
				left: 4px;
				right: 4px;
				padding: 2px 6px;
				background: var(--vscode-editorWidget-background);
				color: var(--vscode-editorWidget-foreground);
				font-family: var(--vscode-editor-font-family);
				font-size: 11px;
				white-space: pre-wrap;
				pointer-events: none;
			}
		</style>
	</head>
	<body>
		<div id="stage">
			<canvas tabindex="0"></canvas>
			<div id="overlay" class="busy">
				<div class="spinner"></div>
				<div id="message">Starting…</div>
			</div>
			<div id="stats" hidden></div>
		</div>
		<pre id="log"></pre>
		<script nonce="${nonce}">
			const canvas = document.querySelector('canvas');
			const overlay = document.getElementById('overlay');
			const overlayMessage = document.getElementById('message');
			const log = document.getElementById('log');
			const stage = document.getElementById('stage');
			const stats = document.getElementById('stats');
			// Counted each second for the stats line
			let counts = { refresh: 0, received: 0, bytes: 0, drawn: 0, missing: 0, dropped: 0, longestGap: 0, uploadMs: 0 };
			let lastArrival = 0;

			// The last frame stays dimmed underneath while the sketch reloads
			const show = (text, busy) => {
				overlay.hidden = false;
				overlay.classList.toggle('busy', busy);
				overlayMessage.textContent = text;
				canvas.style.opacity = '0.35';
			};
			const hide = () => {
				overlay.hidden = true;
				canvas.style.opacity = '';
			};

			// Same values as processing.event and PConstants
			const PRESS = 1, RELEASE = 2, CLICK = 3, DRAG = 4, MOVE = 5, ENTER = 6, EXIT = 7, WHEEL = 8, TYPE = 3;
			const BUTTONS = [37, 3, 39];
			const CODED = 0xFFFF;

			let socket;
			let width = 0;
			let height = 0;
			// Frames waiting to be shown, each with whether it's from the new sketch after a reload
			const queue = [];
			let pressed = 0;
			// The old sketch can send a few more frames after a reload starts, only the new one's clear the overlay
			let restartedAt = 0;
			// Asks ProcessingCLI for the next frame, see Pacer
			const TICK = new Uint8Array([84]).buffer;
			// Newer ProcessingCLIs say when the new sketch is running, older ones only send frames
			let sendsStatus = false;
			let running = false;

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

			// Runs as [count, colour], anything else as [-count, colours...], see Preview.Frames.encode
			let unpacked = new Uint32Array(0);
			const unpack = (data, count) => {
				if (unpacked.length !== count) {
					unpacked = new Uint32Array(count);
				}
				const ints = new Int32Array(data, 16);
				let from = 0, to = 0;
				while (from < ints.length && to < count) {
					const n = ints[from++];
					if (n > 16) {
						unpacked.fill(ints[from++], to, to + n);
						to += n;
					} else if (n > 0) {
						// Quicker than fill for short runs, like a gradient's
						const colour = ints[from++];
						for (const end = to + n; to < end; to++) {
							unpacked[to] = colour;
						}
					} else {
						unpacked.set(ints.subarray(from, from - n), to);
						from -= n;
						to -= n;
					}
				}
				return new Uint8Array(unpacked.buffer);
			};

			// Every display refresh: tick so the sketch draws its next frame now, and show the oldest waiting
			// frame. Oldest, not newest, so a frame that arrives a little late is shown next time instead of skipped
			const draw = () => {
				requestAnimationFrame(draw);
				counts.refresh++;
				if (socket && socket.readyState === WebSocket.OPEN) {
					socket.send(TICK);
				}
				const next = queue.shift();
				if (!next) {
					counts.missing++;
					return;
				}
				const started = performance.now();
				const frame = new DataView(next.data);
				// The top bit of the width marks run-length encoded pixels
				const packed = frame.getInt32(0, true) < 0;
				const pixelWidth = frame.getInt32(0, true) & 0x7FFFFFFF, pixelHeight = frame.getInt32(4, true);
				const pixels = packed ? unpack(next.data, pixelWidth * pixelHeight) : new Uint8Array(next.data, 16, pixelWidth * pixelHeight * 4);
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
				counts.drawn++;
				counts.uploadMs += performance.now() - started;
				if (next.isNew) {
					hide();
				}
			};
			requestAnimationFrame(draw);

			// Keeps trying, ProcessingCLI opens the port once the sketch has compiled
			const connect = () => {
				// Opened after the reload started means the new sketch. Not when it was made, on Windows a
				// connection to a port nobody's listening on yet keeps retrying and can open seconds later
				let opened = 0;
				socket = new WebSocket('ws://127.0.0.1:${port}/${token}');
				socket.binaryType = 'arraybuffer';
				socket.onopen = () => {
					opened = Date.now();
					// Asks for compressed frames, older ProcessingCLIs ignore it and send raw ones
					socket.send(new Uint8Array([67]).buffer);
				};
				socket.onmessage = (e) => {
					if (typeof e.data === 'string') {
						status(JSON.parse(e.data).type);
						return;
					}
					queue.push({ data: e.data, isNew: sendsStatus ? running : opened >= restartedAt });
					const now = performance.now();
					counts.received++;
					counts.bytes += e.data.byteLength;
					counts.longestGap = Math.max(counts.longestGap, lastArrival ? now - lastArrival : 0);
					lastArrival = now;
					// More than two waiting means the preview is falling behind, drop the oldest
					if (queue.length > 2) {
						queue.shift();
						counts.dropped++;
					}
				};
				socket.onerror = () => {};
				socket.onclose = () => setTimeout(connect, 100);
			};
			connect();

			// From ProcessingCLI: starting, reloading, running, error, stopped
			const status = (type) => {
				sendsStatus = true;
				running = type === 'running';
				if (type === 'reloading') {
					show('Reloading…', true);
				} else if (type === 'error') {
					show('The sketch has an error, see the output below. Save to try again.', false);
				} else if (type === 'stopped') {
					show('Sketch stopped. Save to restart.', false);
				}
			};

			// Which GPU WebGL is on, a software renderer like SwiftShader means no acceleration
			const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
			const renderer = gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
			setInterval(() => {
				const c = counts;
				stats.textContent = c.refresh + ' Hz display, ' + c.received + ' frames received, ' + c.drawn + ' drawn, '
					+ c.missing + ' refreshes with no frame, ' + c.dropped + ' dropped, ' + (c.bytes / 1e6).toFixed(1) + ' MB/s\\n'
					+ 'longest gap ' + Math.round(c.longestGap) + ' ms, upload ' + (c.drawn ? (c.uploadMs / c.drawn).toFixed(1) : '-') + ' ms, '
					+ canvas.width + '×' + canvas.height + ', ' + renderer;
				counts = { refresh: 0, received: 0, bytes: 0, drawn: 0, missing: 0, dropped: 0, longestGap: 0, uploadMs: 0 };
			}, 1000);

			addEventListener('message', ({ data: message }) => {
				if (message.type === 'stats') {
					stats.hidden = !stats.hidden;
				} else if (message.type === 'start') {
					restartedAt = Date.now();
					running = false;
					show(width ? 'Reloading…' : 'Starting…', true);
					log.textContent = '';
				} else if (message.type === 'stopped') {
					show(message.error ? 'Sketch stopped with an error, see the output below. Save to try again.' : 'Sketch stopped. Save to restart.', false);
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
