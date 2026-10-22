import {type ChildProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';

import {QueueError} from '../errors.ts';
import {spawnProcess, spawnProcessSync} from './spawn.ts';

const TERMINATE_TIMEOUT_MILLISECONDS = 5000;
const TERMINATE_POLL_MILLISECONDS = 50;

/** Options for one streamed child process. */
export type RunStreamProcessOptions = {
	readonly command: readonly string[];
	readonly cwd?: string;
	readonly timeoutSeconds: number;
	readonly signal?: AbortSignal;
	readonly shell?: boolean;
	readonly onStdoutLine?: (line: string) => void;
	readonly onStderrLine?: (line: string) => void;
};

/** Outcome of one streamed child process. */
export type RunStreamProcessResult = {
	readonly exitCode: number;
	readonly timedOut: boolean;
	readonly aborted: boolean;
};

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
	try {
		process.kill(-pid, signal);
	} catch {
		// The process group is already gone.
	}
};

const groupIsAlive = (pid: number): boolean => {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Terminates a child and all of its descendants, escalating after the grace period. */
const terminateTree = async (child: ChildProcess): Promise<void> => {
	const {pid} = child;
	if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	if (process.platform === 'win32') {
		spawnProcessSync('taskkill', ['/pid', String(pid), '/T', '/F'], {stdio: 'ignore'});
		return;
	}

	signalGroup(pid, 'SIGTERM');
	const deadline = Date.now() + TERMINATE_TIMEOUT_MILLISECONDS;
	while (Date.now() < deadline) {
		if (!groupIsAlive(pid)) {
			return;
		}
		await delay(TERMINATE_POLL_MILLISECONDS);
	}
	signalGroup(pid, 'SIGKILL');
};

const consumeStream = async (stream: NodeJS.ReadableStream | null, callback: ((line: string) => void) | undefined): Promise<void> => {
	if (stream === null || callback === undefined) {
		stream?.resume();
		return;
	}
	const reader = createInterface({input: stream, crlfDelay: Number.POSITIVE_INFINITY});
	for await (const line of reader) {
		callback(line);
	}
};

const consumeStreams = async (child: ChildProcess, options: RunStreamProcessOptions): Promise<void> => {
	await Promise.all([consumeStream(child.stdout, options.onStdoutLine), consumeStream(child.stderr, options.onStderrLine)]);
};

/** Runs a process, streams line-oriented output, and enforces timeout and cancellation. */
export const runStreamProcess = async (options: RunStreamProcessOptions): Promise<RunStreamProcessResult> => {
	const [executable, ...args] = options.command;
	if (executable === undefined) {
		throw new QueueError('Cannot run an empty command');
	}

	const child = spawnProcess(executable, args, {
		...(options.cwd === undefined ? {} : {cwd: options.cwd}),
		shell: options.shell ?? false,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
	});
	let spawnError: Error | undefined;
	const exited = new Promise<number>((resolve) => {
		child.once('error', (error) => {
			spawnError = error;
			resolve(1);
		});
		child.once('close', (code) => {
			resolve(code ?? 1);
		});
	});

	const consumed = consumeStreams(child, options);
	let timedOut = false;
	let aborted = false;
	const onAbort = (): void => {
		aborted = true;
	};
	options.signal?.addEventListener('abort', onAbort, {once: true});
	if (options.signal?.aborted === true) {
		aborted = true;
	}

	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			resolve('timeout');
		}, options.timeoutSeconds * 1000);
	});
	const abort = new Promise<'abort'>((resolve) => {
		if (options.signal?.aborted === true || aborted) {
			resolve('abort');
			return;
		}
		options.signal?.addEventListener(
			'abort',
			() => {
				resolve('abort');
			},
			{once: true},
		);
	});

	try {
		const outcome = await Promise.race([exited.then(() => 'exit' as const), timeout, abort]);
		if (outcome !== 'exit') {
			await terminateTree(child);
		}
		const exitCode = await exited;
		await consumed;
		if (spawnError) {
			throw new QueueError(`Cannot start ${executable}: ${spawnError.message}`);
		}
		return {exitCode, timedOut, aborted};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', onAbort);
	}
};
