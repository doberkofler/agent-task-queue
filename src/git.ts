import {QueueError} from './errors.ts';
import {spawnProcessSync} from './platform/spawn.ts';

/** Runs a Git command in a working directory and returns trimmed stdout. */
export const runGit = (args: readonly string[], cwd = process.cwd()): string => {
	const result = spawnProcessSync('git', args, {cwd, encoding: 'utf8'});
	if (result.error) {
		throw new QueueError(`Cannot run git: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new QueueError(`git ${args[0] ?? ''} failed: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
};

/** Returns the absolute root of a Git working tree. */
export const repositoryRoot = (cwd = process.cwd()): string => runGit(['rev-parse', '--show-toplevel'], cwd);

/** Rejects a working tree that contains tracked or untracked changes. */
export const requireCleanTree = (context: string, cwd = process.cwd()): void => {
	if (runGit(['status', '--porcelain'], cwd).length > 0) {
		throw new QueueError(`Dirty tree ${context}`);
	}
};

/** Rewrites a GitHub issue URL into `owner/repository#number` form. */
export const githubClosureReference = (issueUrl: string): string => {
	const match = /https:\/\/github\.com\/(?<owner>[\w.-]+)\/(?<repository>[\w.-]+)\/issues\/(?<issue>[1-9]\d*)\/?/u.exec(issueUrl);
	const owner = match?.groups?.['owner'];
	const repository = match?.groups?.['repository'];
	const issue = match?.groups?.['issue'];
	if (owner === undefined || repository === undefined || issue === undefined) {
		throw new QueueError(`Invalid GitHub issue URL: ${issueUrl}`);
	}
	return `${owner}/${repository}#${issue}`;
};

/** Reports whether a closure commit for the issue already exists locally. */
export const hasCompletionCommit = (issueUrl: string, cwd = process.cwd()): boolean => {
	const reference = githubClosureReference(issueUrl);
	const escaped = reference.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
	return runGit(['log', '-n', '1', '--format=%H', '--extended-regexp', `--grep=^Closes ${escaped}$`], cwd).length > 0;
};
