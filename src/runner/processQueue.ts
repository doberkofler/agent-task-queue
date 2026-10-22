import {type Configuration} from '../config.ts';
import {QueueError} from '../errors.ts';
import {requireCleanTree, runGit} from '../git.ts';
import {loadQueue, type LoadQueueOptions} from '../queue/loadQueue.ts';
import {type QueueItem} from '../types.ts';
import {formatDuration} from '../sanitize.ts';
import {validateAgentCommit} from './commitValidation.ts';
import {runAgent} from './runAgent.ts';
import {describeCommand, runVerification, verificationLogs} from './verification.ts';

/** Inputs for one complete queue-processing run. */
export type ProcessQueueOptions = {
	readonly queuePath: string | null;
	readonly queueContent: string | null;
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

const runPostCommitVerification = async (options: ProcessQueueOptions, item: QueueItem): Promise<void> => {
	const {command} = options.configuration.verification;
	if (command === null || !options.configuration.verification.afterEachTask) {
		return;
	}
	await runVerification({
		command,
		timeoutSeconds: options.configuration.verification.timeoutSeconds,
		logs: verificationLogs('post-commit'),
		phase: 'post-commit',
		...(options.signal === undefined ? {} : {signal: options.signal}),
	});
	cleanTree(options.configuration, `after verification: ${item.description}`);
};

const preflight = async (options: ProcessQueueOptions): Promise<void> => {
	const {command} = options.configuration.verification;
	if (command === null) {
		process.stdout.write('[verify] skipped by explicit --no-verify\n');
		return;
	}
	if (!options.configuration.verification.preflight) {
		return;
	}
	await runVerification({
		command,
		timeoutSeconds: options.configuration.verification.timeoutSeconds,
		logs: verificationLogs('preflight'),
		phase: 'preflight',
		...(options.signal === undefined ? {} : {signal: options.signal}),
	});
	cleanTree(options.configuration, 'after verification preflight');
};

const processItem = async (
	options: ProcessQueueOptions,
	queue: ReturnType<typeof loadQueue>,
	item: QueueItem,
	totals: {completed: number; itemSeconds: number},
): Promise<void> => {
	const {configuration} = options;
	const started = Date.now();
	const cwd = process.cwd();
	cleanTree(configuration, `before: ${item.description}`);
	const previousHead = configuration.repository.commitPolicy === 'none' ? null : runGit(['rev-parse', 'HEAD'], cwd);
	await runAgent({
		item,
		queuePath: options.queuePath,
		configuration,
		verbose: options.verbose,
		...(options.signal === undefined ? {} : {signal: options.signal}),
	});
	cleanTree(configuration, `after: ${item.description}`);
	if (previousHead !== null) {
		validateAgentCommit({previousHead, queuePath: options.queuePath, configuration, cwd});
	}
	const agentCommit = runGit(['rev-parse', '--short', 'HEAD'], cwd);
	await runPostCommitVerification(options, item);
	await queue.commitDone(item);
	const duration = (Date.now() - started) / 1000;
	totals.completed += 1;
	totals.itemSeconds += duration;
	process.stdout.write(`[result] #${String(item.issue)} done · commit ${agentCommit} · ${formatDuration(duration)}\n`);
};

/** Processes every pending queue item sequentially. */
export const processQueue = async (options: ProcessQueueOptions): Promise<void> => {
	const {configuration} = options;
	const started = Date.now();
	const queueDisplay = options.queuePath ?? 'stdin';
	const verificationDisplay = configuration.verification.command === null ? 'disabled' : describeCommand(configuration.verification.command);
	process.stdout.write(`[run] queue · ${queueDisplay}\n`);
	process.stdout.write(`[run] model · ${configuration.agent.model ?? 'default'}\n`);
	process.stdout.write(`[run] verify · ${verificationDisplay}\n`);
	process.stdout.write(
		`[run] timeouts · agent ${formatDuration(configuration.agent.timeoutSeconds)} · verify ${formatDuration(configuration.verification.timeoutSeconds)}\n`,
	);

	const initialQueue = loadQueue(options.queuePath, options.queueContent, queueLoader(options));
	requireGithubCompletion(configuration, initialQueue.kind);
	cleanTree(configuration, 'before verification preflight');
	await preflight(options);

	const totals = {completed: 0, itemSeconds: 0};
	for (;;) {
		const queue = loadQueue(options.queuePath, options.queueContent, queueLoader(options));
		const item = await queue.nextItem();
		if (item === null) {
			const details = [`${String(totals.completed)} completed`, `${formatDuration((Date.now() - started) / 1000)} total`];
			if (totals.completed > 0) {
				details.push(`${formatDuration(totals.itemSeconds / totals.completed)} average`);
			}
			process.stdout.write(`[run] ${details.join(' · ')}\n`);
			return;
		}
		await processItem(options, queue, item, totals);
	}
};
