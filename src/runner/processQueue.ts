import {type Configuration} from '../config.ts';
import {QueueError} from '../errors.ts';
import {requireCleanTree, runGit} from '../git.ts';
import {loadQueue, type LoadQueueOptions} from '../queue/loadQueue.ts';
import {TerminalProgress} from '../report/progress.ts';
import {type QueueItem} from '../types.ts';
import {validateAgentCommit} from './commitValidation.ts';
import {runAgent} from './runAgent.ts';
import {describeCommand, runVerification, verificationLogs} from './verification.ts';

/** Inputs for one complete queue-processing run. */
export type ProcessQueueOptions = {
	readonly queuePath: string | null;
	readonly queueContent: string | null;
	readonly queueLabel: string;
	readonly configuration: Configuration;
	readonly verbose: boolean;
	readonly signal?: AbortSignal;
};

const queueLoader = (options: ProcessQueueOptions): LoadQueueOptions => ({
	commitCompletion: options.configuration.completion.commit,
	closeIssueOnCommit: options.configuration.completion.closeGitHubIssue,
	cwd: process.cwd(),
});

const requireGithubCompletion = (configuration: Configuration, kind: string): void => {
	if (kind === 'github-issues' && (!configuration.completion.commit || !configuration.completion.closeGitHubIssue)) {
		throw new QueueError('GitHub issue queues require completion.commit true and completion.closeGitHubIssue true');
	}
};

const cleanTree = (configuration: Configuration, context: string): void => {
	if (configuration.repository.requireCleanTree) {
		requireCleanTree(context, process.cwd());
	}
};

const runPostCommitVerification = async (options: ProcessQueueOptions, progress: TerminalProgress): Promise<void> => {
	const {command} = options.configuration.verification;
	if (command === null || !options.configuration.verification.afterEachTask) {
		return;
	}
	await runVerification({
		command,
		timeoutSeconds: options.configuration.verification.timeoutSeconds,
		logs: verificationLogs('post-commit'),
		phase: 'Post-commit',
		progress,
		...(options.signal === undefined ? {} : {signal: options.signal}),
	});
};

const preflight = async (options: ProcessQueueOptions, progress: TerminalProgress): Promise<void> => {
	const {command} = options.configuration.verification;
	if (command === null) {
		progress.report({type: 'phase-skipped', label: 'Verify', reason: '--no-verify'});
		return;
	}
	if (!options.configuration.verification.preflight) {
		return;
	}
	await runVerification({
		command,
		timeoutSeconds: options.configuration.verification.timeoutSeconds,
		logs: verificationLogs('preflight'),
		phase: 'Preflight',
		progress,
		...(options.signal === undefined ? {} : {signal: options.signal}),
	});
};

const processItem = async (
	options: ProcessQueueOptions,
	state: {readonly progress: TerminalProgress; readonly totals: {completed: number; itemSeconds: number}},
	queue: ReturnType<typeof loadQueue>,
	item: QueueItem,
): Promise<void> => {
	const {configuration} = options;
	const {progress, totals} = state;
	const started = Date.now();
	progress.report({type: 'task-started', item});
	try {
		const cwd = process.cwd();
		cleanTree(configuration, `before: ${item.description}`);
		const previousHead = configuration.repository.commitPolicy === 'none' ? null : runGit(['rev-parse', 'HEAD'], cwd);
		const agent = await runAgent({
			item,
			queuePath: options.queuePath,
			configuration,
			verbose: options.verbose,
			progress,
			...(options.signal === undefined ? {} : {signal: options.signal}),
		});
		cleanTree(configuration, `after: ${item.description}`);
		if (previousHead !== null) {
			validateAgentCommit({previousHead, queuePath: options.queuePath, configuration, cwd});
		}
		const agentCommit = configuration.repository.commitPolicy === 'none' ? null : runGit(['rev-parse', '--short', 'HEAD'], cwd);
		await runPostCommitVerification(options, progress);
		cleanTree(configuration, `after verification: ${item.description}`);
		await queue.commitDone(item);
		const duration = (Date.now() - started) / 1000;
		totals.completed += 1;
		totals.itemSeconds += duration;
		progress.report({
			type: 'task-finished',
			item,
			stats: {
				durationSeconds: duration,
				tools: agent.tools,
				tokens: agent.tokens,
				cost: agent.cost,
				commit: agentCommit,
			},
			summary: agent.finalText.split('\n'),
		});
	} catch (error) {
		progress.report({type: 'task-aborted'});
		throw error;
	}
};

/** Processes every pending queue item sequentially. */
export const processQueue = async (options: ProcessQueueOptions): Promise<void> => {
	const {configuration} = options;
	const started = Date.now();
	const progress = new TerminalProgress(process.stdout, {verbose: options.verbose});
	const {command} = configuration.verification;
	try {
		progress.report({
			type: 'run-started',
			queue: options.queueLabel,
			model: configuration.agent.model,
			verification: command === null ? null : describeCommand(command),
		});

		const initialQueue = loadQueue(options.queuePath, options.queueContent, queueLoader(options));
		requireGithubCompletion(configuration, initialQueue.kind);
		cleanTree(configuration, 'before verification preflight');
		await preflight(options, progress);

		const totals = {completed: 0, itemSeconds: 0};
		const state = {progress, totals};
		for (;;) {
			const queue = loadQueue(options.queuePath, options.queueContent, queueLoader(options));
			const item = await queue.nextItem();
			if (item === null) {
				progress.report({type: 'run-finished', completed: totals.completed, durationSeconds: (Date.now() - started) / 1000});
				return;
			}
			await processItem(options, state, queue, item);
		}
	} finally {
		progress.close();
	}
};
