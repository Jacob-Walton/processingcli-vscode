import { execFile } from 'child_process';
import { join } from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- tree-kill uses export =
import treeKill = require('tree-kill');

// tree-kill runs taskkill through a shell, which flashes a console window when VS Code starts it
export function killTree(pid: number) {
	return new Promise<void>((resolve) => {
		if (process.platform === 'win32') {
			const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
			execFile(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
		} else {
			treeKill(pid, 'SIGKILL', () => resolve());
		}
	});
}
