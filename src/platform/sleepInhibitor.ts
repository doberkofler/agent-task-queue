import {spawn, type ChildProcess} from 'node:child_process';
import {accessSync, constants, existsSync} from 'node:fs';
import path from 'node:path';

import {QueueError} from '../errors.ts';
import {environment} from '../environment.ts';

const TERMINATE_TIMEOUT_MILLISECONDS = 5000;

const isExecutable = (candidate: string): boolean => {
	try {
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

/** Finds an executable on PATH without invoking a shell. */
const findExecutable = (name: string): string | null => {
	for (const directory of environment.PATH.split(path.delimiter)) {
		const candidate = path.join(directory, name);
		if (existsSync(candidate) && isExecutable(candidate)) {
			return candidate;
		}
	}
	return null;
};

/** Returns the platform-specific command that inhibits idle sleep, if supported. */
export const sleepInhibitorCommand = (platform: NodeJS.Platform, executable: string | null, pid: number): readonly string[] | null => {
	if (executable === null) {
		return null;
	}
	if (platform === 'darwin') {
		return [executable, '-i', '-w', String(pid)];
	}
	if (platform === 'linux') {
		return [executable, '--what=idle', '--why=agent-task-queue', '--mode=block', 'sleep', 'infinity'];
	}
	return null;
};

/** Starts an idle-sleep inhibitor for the lifetime of this process. */
export const startSleepInhibitor = (): ChildProcess | null => {
	const executable = process.platform === 'darwin' ? findExecutable('caffeinate') : process.platform === 'linux' ? findExecutable('systemd-inhibit') : null;
	if (process.platform === 'darwin' && executable === null) {
		throw new QueueError('macOS caffeinate executable is unavailable');
	}
	const command = sleepInhibitorCommand(process.platform, executable, process.pid);
	if (command === null) {
		return null;
	}
	const [binary, ...args] = command;
	if (binary === undefined) {
		return null;
	}
	const child = spawn(binary, args, {stdio: 'ignore', detached: true});
	child.once('error', () => {
		// Sleep inhibition is best-effort on platforms beyond macOS.
	});
	child.unref();
	return child;
};

/** Stops an inhibitor, escalating to SIGKILL when it does not exit promptly. */
export const stopSleepInhibitor = async (child: ChildProcess | null): Promise<void> => {
	if (child?.exitCode !== null) {
		return;
	}
	const exited = new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			resolve(false);
		}, TERMINATE_TIMEOUT_MILLISECONDS);
		child.once('exit', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
	child.kill('SIGTERM');
	if (!(await exited)) {
		child.kill('SIGKILL');
	}
};
