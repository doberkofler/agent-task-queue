import {existsSync} from 'node:fs';

import {QueueError, TerminationRequestedError} from '../errors.ts';
import {repositoryRoot} from '../git.ts';
import {allocateLogPaths, closeQuietly, displayPath, openAppend, openPrivate, writeTo} from '../logFiles.ts';
import {logDirectory} from '../logDirectory.ts';
import {runStreamProcess} from '../platform/process.ts';
import {LiveDisplay} from '../report/liveDisplay.ts';
import {createPalette} from '../report/style.ts';
import {formatDuration, sanitize} from '../sanitize.ts';
import {type RunLogs} from '../types.ts';
import {printFailureTail} from './diagnostics.ts';
import {LineTail} from './lineTail.ts';

const FAILURE_TAIL_LINES = 20;

/** Inputs for one independent verification phase. */
export type VerificationOptions = {
	readonly command: string | readonly string[];
	readonly timeoutSeconds: number;
	readonly logs: RunLogs;
	readonly phase: string;
	readonly signal?: AbortSignal;
};

/** Human-readable verification command. */
export const describeCommand = (command: string | readonly string[]): string => (typeof command === 'string' ? command : command.join(' '));

/** Runs one trusted verification command and appends its output to the run history. */
export const runVerification = async (options: VerificationOptions): Promise<void> => {
	if (!existsSync(options.logs.history)) {
		closeQuietly(openPrivate(options.logs.history));
	}
	const palette = createPalette(process.stdout);
	process.stdout.write(`  ${palette.cyan('●')} verify ${palette.bold(options.phase)}\n`);
	process.stdout.write(`    ${palette.dim('command')}  ${describeCommand(options.command)}\n`);
	process.stdout.write(`    ${palette.dim('log')}      ${displayPath(options.logs.history)}\n`);
	const live = new LiveDisplay(process.stdout);
	live.setPhase(`verify ${options.phase}`);
	const tail = new LineTail(FAILURE_TAIL_LINES);
	const started = Date.now();
	const descriptor = openAppend(options.logs.history);

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
				live.add(sanitize(line));
			},
			onStderrLine: (line) => {
				writeTo(descriptor, `[verify:stderr] ${line}\n`);
				tail.add(`stderr: ${sanitize(line)}`);
				live.add(sanitize(line));
			},
		});
		if (result.aborted) {
			throw new TerminationRequestedError();
		}
		const elapsed = formatDuration((Date.now() - started) / 1000);
		if (result.timedOut) {
			process.stdout.write(`  ${palette.red('✗')} verify ${options.phase} timed out ${palette.dim(`after ${formatDuration(options.timeoutSeconds)}`)}\n`);
			printFailureTail(tail);
			throw new QueueError(`Verification timed out; log: ${displayPath(options.logs.history)}`);
		}
		if (result.exitCode !== 0) {
			process.stdout.write(
				`  ${palette.red('✗')} verify ${options.phase} failed ${palette.dim(`(exit ${String(result.exitCode)})`)} ${palette.dim(`in ${elapsed}`)}\n`,
			);
			printFailureTail(tail);
			throw new QueueError(`Verification exited with status ${String(result.exitCode)}; log: ${displayPath(options.logs.history)}`);
		}
		process.stdout.write(`  ${palette.green('✓')} verify ${options.phase} passed ${palette.dim(`in ${elapsed}`)}\n`);
	} finally {
		live.clear();
		closeQuietly(descriptor);
	}
};

/** Allocates the log pair used by one verification phase. */
export const verificationLogs = (phase: string): RunLogs => allocateLogPaths(logDirectory(), phase);
