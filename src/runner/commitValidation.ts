import path from 'node:path';

import {type Configuration} from '../config.ts';
import {QueueError} from '../errors.ts';
import {runGit} from '../git.ts';

const AGENT_COMMIT_ERROR = 'Agent must create exactly one non-merge commit';
const AT_LEAST_ONE_COMMIT_ERROR = 'Agent must create at least one commit';
const NO_CHANGES_ERROR = 'Agent commit must contain changes';
const QUEUE_ERROR = 'Agent commit must not modify the queue';

/** Inputs for validating the commit(s) an agent produced. */
export type CommitValidationOptions = {
	readonly previousHead: string;
	readonly queuePath: string | null;
	readonly configuration: Configuration;
	readonly cwd?: string;
};

const changedPaths = (policy: 'exactly-one' | 'at-least-one', previousHead: string, cwd: string): readonly string[] =>
	(policy === 'exactly-one'
		? runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], cwd)
		: runGit(['diff', '--name-only', previousHead, 'HEAD'], cwd)
	)
		.split('\n')
		.filter(Boolean);

const queueIsUntouched = (paths: readonly string[], queuePath: string | null): void => {
	if (queuePath === null) {
		return;
	}
	const absoluteQueue = path.resolve(queuePath);
	const relativeQueue = ((): string => {
		try {
			// Let Git map the working-directory path onto the repository; this avoids
			// case, separator, and Windows short-name mismatches in path arithmetic.
			const prefix = runGit(['rev-parse', '--show-prefix'], path.dirname(absoluteQueue));
			return `${prefix}${path.basename(absoluteQueue)}`.replaceAll('\\', '/');
		} catch (error) {
			throw new QueueError('Queue must be inside the Git repository', {cause: error});
		}
	})();
	if (paths.includes(relativeQueue)) {
		throw new QueueError(QUEUE_ERROR);
	}
};

/** Enforces the configured agent commit policy and queue immutability. */
export const validateAgentCommit = (options: CommitValidationOptions): void => {
	const {configuration} = options;
	if (configuration.repository.commitPolicy === 'none') {
		return;
	}
	const cwd = options.cwd ?? process.cwd();

	const parents = runGit(['rev-list', '--parents', '-n', '1', 'HEAD'], cwd).split(' ');
	if (configuration.repository.commitPolicy === 'exactly-one' && (parents.length !== 2 || parents[1] !== options.previousHead)) {
		throw new QueueError(AGENT_COMMIT_ERROR);
	}
	if (configuration.repository.commitPolicy === 'at-least-one' && runGit(['rev-parse', 'HEAD'], cwd) === options.previousHead) {
		throw new QueueError(AT_LEAST_ONE_COMMIT_ERROR);
	}

	const paths = changedPaths(configuration.repository.commitPolicy, options.previousHead, cwd);
	if (configuration.repository.requireChangedFiles && paths.length === 0) {
		throw new QueueError(NO_CHANGES_ERROR);
	}
	queueIsUntouched(paths, options.queuePath);
};
