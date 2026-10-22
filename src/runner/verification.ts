import {existsSync} from 'node:fs';

import {QueueError, TerminationRequestedError} from '../errors.ts';
import {repositoryRoot} from '../git.ts';
import {allocateLogPaths, closeQuietly, displayPath, openAppend, openPrivate, writeTo} from '../logFiles.ts';
import {logDirectory} from '../logDirectory.ts';
import {runStreamProcess} from '../platform/process.ts';
import {type TerminalProgress} from '../report/progress.ts';
import {formatDuration, sanitize} from '../sanitize.ts';
import {type RunLogs} from '../types.ts';
import {LineTail} from './lineTail.ts';

const FAILURE_TAIL_LINES = 20;

/** Inputs for one independent verification phase. */
export type VerificationOptions = {
	readonly command: string | readonly string[];
	readonly timeoutSeconds: number;
	readonly logs: RunLogs;
	readonly phase: string;
	readonly progress: TerminalProgress;
	readonly signal?: AbortSignal;
};

/** Human-readable verification command. */
export const describeCommand = (command: string | readonly string[]): string => (typeof command === 'string' ? command : command.join(' '));

/** Runs one trusted verification command and appends its output to the run history. */
export const runVerification = async (options: VerificationOptions): Promise<void> => {
	if (!existsSync(options.logs.history)) {
		closeQuietly(openPrivate(options.logs.history));
	}
	options.progress.report({type: 'phase-started', label: options.phase});
	const tail = new LineTail(FAILURE_TAIL_LINES);
	const started = Date.now();
	const descriptor = openAppend(options.logs.history);
	const logPath = displayPath(options.logs.history);
	if (options.progress.verbose) {
		options.progress.report({type: 'verbose', text: `log ${logPath}`});
	}

	try {
		const result = await runStreamProcess({
			command: typeof options.command === 'string' ? [options.command] : options.command,
			shell: typeof options.command === 'string',
			cwd: repositoryRoot(process.cwd()),
			timeoutSeconds: options.timeoutSeconds,
			...(options.signal === undefined ? {} : {signal: options.signal}),
			onStdoutLine: (line) => {
				writeTo(descriptor, `[verify:stdout] ${line}\n`);
				tail.add(`stdout: ${sanitize(line)}`);
				options.progress.report({type: 'activity', detail: sanitize(line)});
			},
			onStderrLine: (line) => {
				writeTo(descriptor, `[verify:stderr] ${line}\n`);
				tail.add(`stderr: ${sanitize(line)}`);
				options.progress.report({type: 'activity', detail: sanitize(line)});
			},
		});
		if (result.aborted) {
			throw new TerminationRequestedError();
		}
		const durationSeconds = (Date.now() - started) / 1000;
		if (result.timedOut) {
			options.progress.report({
				type: 'failure',
				label: options.phase,
				outcome: {durationSeconds, timedOut: true},
				logPath,
				tail: [...tail.values()],
			});
			throw new QueueError(`Verification timed out after ${formatDuration(options.timeoutSeconds)}`);
		}
		if (result.exitCode !== 0) {
			options.progress.report({
				type: 'failure',
				label: options.phase,
				outcome: {durationSeconds, exitCode: result.exitCode},
				logPath,
				tail: [...tail.values()],
			});
			throw new QueueError(`Verification exited with status ${String(result.exitCode)}`);
		}
		options.progress.report({type: 'phase-finished', label: options.phase, outcome: {durationSeconds}});
	} finally {
		closeQuietly(descriptor);
	}
};

/** Allocates the log pair used by one verification phase. */
export const verificationLogs = (phase: string): RunLogs => allocateLogPaths(logDirectory(), phase);
