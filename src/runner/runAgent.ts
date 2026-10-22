import {openCodeCommand} from '../agent/openCode.ts';
import {type Configuration} from '../config.ts';
import {QueueError, TerminationRequestedError} from '../errors.ts';
import {closeQuietly, allocateLogPaths, displayPath, openPrivate, writeTo} from '../logFiles.ts';
import {logDirectory} from '../logDirectory.ts';
import {runStreamProcess} from '../platform/process.ts';
import {RunReporter} from '../report/reporter.ts';
import {formatDuration, sanitize} from '../sanitize.ts';
import {type QueueItem, type RunLogs} from '../types.ts';
import {printFailureTail} from './diagnostics.ts';
import {LineTail} from './lineTail.ts';

const FAILURE_TAIL_LINES = 20;

/** Inputs for running one agent session. */
export type AgentRunOptions = {
	readonly item: QueueItem;
	readonly queuePath: string | null;
	readonly configuration: Configuration;
	readonly verbose: boolean;
	readonly signal?: AbortSignal;
};

/** Runs the configured agent, writes both logs, and enforces the runtime contract. */
export const runAgent = async (options: AgentRunOptions): Promise<RunLogs> => {
	const logs = allocateLogPaths(logDirectory(), options.item.issue);
	const reporter = new RunReporter({
		model: options.configuration.agent.model,
		agentName: options.configuration.agent.name,
		verbose: options.verbose,
		stream: process.stdout,
	});
	const tail = new LineTail(FAILURE_TAIL_LINES);
	const agentDescriptor = openPrivate(logs.agent);
	let historyDescriptor: number | undefined;

	try {
		const history = openPrivate(logs.history);
		historyDescriptor = history;
		reporter.start(options.item, logs);
		const result = await runStreamProcess({
			command: openCodeCommand({
				item: options.item,
				queuePath: options.queuePath,
				model: options.configuration.agent.model,
				agentName: options.configuration.agent.name,
				commitPolicy: options.configuration.repository.commitPolicy,
			}),
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
		if (result.aborted) {
			reporter.interrupted();
			throw new TerminationRequestedError();
		}
		reporter.finish(result.exitCode);
		if (result.timedOut) {
			printFailureTail(tail);
			throw new QueueError(`OpenCode timed out after ${formatDuration(options.configuration.agent.timeoutSeconds)}; log: ${displayPath(logs.history)}`);
		}
		if (result.exitCode !== 0) {
			printFailureTail(tail);
			throw new QueueError(`OpenCode exited with status ${String(result.exitCode)}; log: ${displayPath(logs.history)}`);
		}
		if (reporter.backgroundJobStarted) {
			throw new QueueError(`Agent started a background job; all work must finish before exit; log: ${displayPath(logs.history)}`);
		}
		return logs;
	} finally {
		if (historyDescriptor !== undefined) {
			closeQuietly(historyDescriptor);
		}
		closeQuietly(agentDescriptor);
	}
};
