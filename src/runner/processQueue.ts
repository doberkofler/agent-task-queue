import {type Configuration} from '../config.ts';
import {QueueError} from '../errors.ts';
import {requireCleanTree, runGit} from '../git.ts';
import {loadQueue, type LoadQueueOptions} from '../queue/loadQueue.ts';
import {createPalette} from '../report/style.ts';
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

const writeRunHeader = (configuration: Configuration, queueDisplay: string): void => {
	const palette = createPalette(process.stdout);
	const verification = configuration.verification.command === null ? 'disabled' : describeCommand(configuration.verification.command);
	const info = (label: string, value: string): string => `    ${palette.dim(label.padEnd(9))}${value}\n`;
	process.stdout.write(`\n  ${palette.cyan(palette.bold('RUN'))}  ${palette.bold('agent-task-queue')}\n\n`);
	process.stdout.write(info('queue', queueDisplay));
	process.stdout.write(info('model', configuration.agent.model ?? 'default'));
	process.stdout.write(info('verify', verification));
	process.stdout.write(
		info('timeouts', `agent ${formatDuration(configuration.agent.timeoutSeconds)} · verify ${formatDuration(configuration.verification.timeoutSeconds)}`),
	);
	process.stdout.write('\n');
};

const writeItemResult = (item: QueueItem, commit: string, duration: number): void => {
	const palette = createPalette(process.stdout);
	const details = [`commit ${palette.cyan(commit)}`, palette.dim(formatDuration(duration))];
	process.stdout.write(
		`  ${palette.green('✓')} ${palette.bold(`#${String(item.issue)}`)} ${palette.green('done')} ${palette.dim('·')} ${details.join(palette.dim(' · '))}\n`,
	);
};

const writeTotals = (totals: {completed: number; itemSeconds: number}, started: number): void => {
	const palette = createPalette(process.stdout);
	const count = `${String(totals.completed)} ${totals.completed === 1 ? 'task' : 'tasks'} completed`;
	const details = [count, `${formatDuration((Date.now() - started) / 1000)} total`];
	if (totals.completed > 0) {
		details.push(`${formatDuration(totals.itemSeconds / totals.completed)} average`);
	}
	process.stdout.write(`  ${palette.green('✓')} ${details.join(palette.dim(' · '))}\n`);
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
		const palette = createPalette(process.stdout);
		process.stdout.write(`  ${palette.cyan('↓')} verify skipped ${palette.dim('(--no-verify)')}\n`);
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
	writeItemResult(item, agentCommit, duration);
};

/** Processes every pending queue item sequentially. */
export const processQueue = async (options: ProcessQueueOptions): Promise<void> => {
	const {configuration} = options;
	const started = Date.now();
	const queueDisplay = options.queuePath ?? 'stdin';
	writeRunHeader(configuration, queueDisplay);

	const initialQueue = loadQueue(options.queuePath, options.queueContent, queueLoader(options));
	requireGithubCompletion(configuration, initialQueue.kind);
	cleanTree(configuration, 'before verification preflight');
	await preflight(options);

	const totals = {completed: 0, itemSeconds: 0};
	for (;;) {
		const queue = loadQueue(options.queuePath, options.queueContent, queueLoader(options));
		const item = await queue.nextItem();
		if (item === null) {
			writeTotals(totals, started);
			return;
		}
		await processItem(options, queue, item, totals);
	}
};
