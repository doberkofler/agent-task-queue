import {openCodeInvocation} from '../agent/openCode.ts';
import {type Configuration} from '../config.ts';
import {QueueError, TerminationRequestedError} from '../errors.ts';
import {closeQuietly, allocateLogPaths, displayPath, openPrivate, writeTo} from '../logFiles.ts';
import {logDirectory} from '../logDirectory.ts';
import {runStreamProcess} from '../platform/process.ts';
import {AgentReporter, type AgentStats} from '../report/agentReporter.ts';
import {type TerminalProgress} from '../report/progress.ts';
import {formatDuration, sanitize} from '../sanitize.ts';
import {type QueueItem} from '../types.ts';
import {LineTail} from './lineTail.ts';

const FAILURE_TAIL_LINES = 20;

/** Inputs for running one agent session. */
export type AgentRunOptions = {
	readonly item: QueueItem;
	readonly queuePath: string | null;
	readonly configuration: Configuration;
	readonly verbose: boolean;
	readonly progress: TerminalProgress;
	readonly signal?: AbortSignal;
};

/** Runs the configured agent, writes both logs, and enforces the runtime contract. */
export const runAgent = async (options: AgentRunOptions): Promise<AgentStats> => {
	const logs = allocateLogPaths(logDirectory(), options.item.issue);
	const reporter = new AgentReporter({progress: options.progress, verbose: options.verbose});
	const tail = new LineTail(FAILURE_TAIL_LINES);
	const agentDescriptor = openPrivate(logs.agent);
	const started = Date.now();
	let historyDescriptor: number | undefined;

	try {
		const history = openPrivate(logs.history);
		historyDescriptor = history;
		reporter.start();
		if (options.verbose) {
			options.progress.report({type: 'verbose', text: `log ${displayPath(logs.history)}`});
		}
		const invocation = openCodeInvocation({
			item: options.item,
			queuePath: options.queuePath,
			model: options.configuration.agent.model,
			agentName: options.configuration.agent.name,
			commitPolicy: options.configuration.repository.commitPolicy,
		});
		const result = await runStreamProcess({
			command: invocation.command,
			stdinText: invocation.prompt,
			timeoutSeconds: options.configuration.agent.timeoutSeconds,
			...(options.signal === undefined ? {} : {signal: options.signal}),
			onStdoutLine: (line) => {
				writeTo(history, `[stdout] ${line}\n`);
				writeTo(agentDescriptor, `${line}\n`);
				tail.add(`stdout: ${sanitize(line)}`);
				reporter.consume(line);
			},
			onStderrLine: (line) => {
				writeTo(history, `[stderr] ${line}\n`);
				if (options.verbose) {
					reporter.consume(line);
				}
				tail.add(`stderr: ${sanitize(line)}`);
			},
		});
		const durationSeconds = (Date.now() - started) / 1000;
		const stats = reporter.finish();
		if (result.aborted) {
			options.progress.report({type: 'interrupted'});
			throw new TerminationRequestedError();
		}
		if (result.timedOut) {
			options.progress.report({
				type: 'failure',
				label: 'Agent',
				outcome: {durationSeconds, timedOut: true},
				logPath: displayPath(logs.history),
				tail: [...tail.values()],
			});
			throw new QueueError(`OpenCode timed out after ${formatDuration(options.configuration.agent.timeoutSeconds)}`);
		}
		if (result.exitCode !== 0) {
			options.progress.report({
				type: 'failure',
				label: 'Agent',
				outcome: {durationSeconds, exitCode: result.exitCode},
				logPath: displayPath(logs.history),
				tail: [...tail.values()],
			});
			throw new QueueError(`OpenCode exited with status ${String(result.exitCode)}`);
		}
		if (reporter.backgroundJobStarted) {
			throw new QueueError('Agent started a background job; all work must finish before exit');
		}
		return stats;
	} finally {
		if (historyDescriptor !== undefined) {
			closeQuietly(historyDescriptor);
		}
		closeQuietly(agentDescriptor);
	}
};
