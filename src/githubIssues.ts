import {z} from 'zod';

import {environment} from './environment.ts';
import {QueueError, UsageError} from './errors.ts';
import {spawnProcessSync} from './platform/spawn.ts';

/** A canonical GitHub issue URL accepted by the queue schema. */
export const GITHUB_ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*\/?$/u;

const GITHUB_REPOSITORY_URL_PATTERN = /^https:\/\/github\.com\/(?<owner>[\w.-]+)\/(?<repository>[\w.-]+)\/?$/u;
const GITHUB_MILESTONE_URL_PATTERN = /^https:\/\/github\.com\/(?<owner>[\w.-]+)\/(?<repository>[\w.-]+)\/milestone\/(?<milestone>[1-9]\d*)\/?$/u;

const GhIssueSchema = z.object({
	number: z.number().int().positive(),
	state: z.enum(['OPEN', 'CLOSED']),
	title: z.string().trim().min(1),
	body: z.string(),
	url: z.string().min(1),
});

const GhRepositorySchema = z.object({url: z.string().regex(GITHUB_REPOSITORY_URL_PATTERN)});

const GhMilestoneIssueSchema = z.object({
	number: z.number().int().positive(),
	html_url: z.string().regex(GITHUB_ISSUE_URL_PATTERN),
	pull_request: z.unknown().optional(),
});

const GhMilestonePagesSchema = z.array(z.array(GhMilestoneIssueSchema));

/** Issue data required to build an agent prompt. */
export type GithubIssue = {
	readonly state: 'OPEN' | 'CLOSED';
	readonly title: string;
	readonly body: string;
};

type GithubRepository = {
	readonly owner: string;
	readonly repository: string;
};

const runGhJson = (args: readonly string[], context: string): unknown => {
	const result = spawnProcessSync(environment.GH_BIN ?? 'gh', [...args], {encoding: 'utf8'});
	if (result.error) {
		throw new QueueError(`Cannot run gh: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new QueueError(`GitHub CLI failed ${context}: ${result.stderr.trim()}`);
	}
	try {
		return JSON.parse(result.stdout);
	} catch (error) {
		throw new QueueError(`GitHub returned invalid JSON ${context}`, {cause: error});
	}
};

const repositoryFromUrl = (url: string): GithubRepository => {
	const match = GITHUB_REPOSITORY_URL_PATTERN.exec(url);
	const owner = match?.groups?.['owner'];
	const repository = match?.groups?.['repository'];
	if (owner === undefined || repository === undefined) {
		throw new QueueError(`GitHub returned an invalid repository URL: ${url}`);
	}
	return {owner, repository};
};

const currentRepository = (): GithubRepository => {
	const parsed = GhRepositorySchema.safeParse(runGhJson(['repo', 'view', '--json', 'url'], 'while resolving the current repository'));
	if (!parsed.success) {
		throw new QueueError('GitHub returned an invalid current repository');
	}
	return repositoryFromUrl(parsed.data.url.replace(/\/$/u, ''));
};

const canonicalIssueUrl = (repository: GithubRepository, issue: number): string =>
	`https://github.com/${repository.owner}/${repository.repository}/issues/${String(issue)}`;

const positiveInteger = (value: string): number | null => {
	if (!/^[1-9]\d*$/u.test(value)) {
		return null;
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
};

/** Resolves a comma-separated mixture of issue numbers and canonical URLs. */
export const resolveGithubIssueUrls = (input: string): readonly string[] => {
	const values = input.split(',').map((value) => value.trim());
	if (values.length === 0 || values.some((value) => value.length === 0)) {
		throw new UsageError('--github-issues must be a comma-separated list of issue numbers or URLs');
	}
	let repository: GithubRepository | null = null;
	const urls: string[] = [];
	const uniqueUrls = new Set<string>();
	for (const value of values) {
		let url: string;
		const issue = positiveInteger(value);
		if (issue !== null) {
			repository ??= currentRepository();
			url = canonicalIssueUrl(repository, issue);
		} else if (GITHUB_ISSUE_URL_PATTERN.test(value)) {
			url = value.replace(/\/$/u, '');
		} else {
			throw new UsageError(`Invalid GitHub issue reference: ${value}`);
		}
		if (uniqueUrls.has(url)) {
			throw new UsageError(`Duplicate GitHub issue URL: ${url}`);
		}
		uniqueUrls.add(url);
		urls.push(url);
	}
	return urls;
};

const milestoneReference = (input: string): {readonly repository: GithubRepository; readonly milestone: number} => {
	const milestoneNumber = positiveInteger(input);
	if (milestoneNumber !== null) {
		return {repository: currentRepository(), milestone: milestoneNumber};
	}
	const match = GITHUB_MILESTONE_URL_PATTERN.exec(input);
	const owner = match?.groups?.['owner'];
	const repository = match?.groups?.['repository'];
	const milestone = match?.groups?.['milestone'];
	const parsedMilestone = milestone === undefined ? null : positiveInteger(milestone);
	if (owner === undefined || repository === undefined || parsedMilestone === null) {
		throw new UsageError(`Invalid GitHub milestone reference: ${input}`);
	}
	return {repository: {owner, repository}, milestone: parsedMilestone};
};

/** Resolves all open, non-pull-request issues in a GitHub milestone. */
export const resolveGithubMilestoneIssueUrls = (input: string): readonly string[] => {
	const reference = milestoneReference(input.trim());
	const repositoryName = `${reference.repository.owner}/${reference.repository.repository}`;
	const parsed = GhMilestonePagesSchema.safeParse(
		runGhJson(
			[
				'api',
				'--method',
				'GET',
				'--paginate',
				'--slurp',
				`repos/${repositoryName}/issues`,
				'-f',
				`milestone=${String(reference.milestone)}`,
				'-f',
				'state=open',
				'-f',
				'per_page=100',
			],
			`while resolving milestone ${repositoryName}#${String(reference.milestone)}`,
		),
	);
	if (!parsed.success) {
		throw new QueueError(`GitHub returned invalid issues for milestone ${repositoryName}#${String(reference.milestone)}`);
	}
	const issues = parsed.data
		.flat()
		.filter((issue) => issue.pull_request === undefined)
		.sort((left, right) => left.number - right.number);
	return issues.map((issue) => {
		const url = issue.html_url.replace(/\/$/u, '');
		if (url !== canonicalIssueUrl(reference.repository, issue.number)) {
			throw new QueueError(`GitHub returned an invalid issue for milestone ${repositoryName}#${String(reference.milestone)}`);
		}
		return url;
	});
};

const issueNumber = (issueUrl: string): number => {
	const match = /\/issues\/(?<issue>[1-9]\d*)\/?$/u.exec(issueUrl);
	const value = match?.groups?.['issue'];
	if (value === undefined) {
		throw new QueueError(`Invalid GitHub issue URL: ${issueUrl}`);
	}
	return Number(value);
};

/** Reads one issue through the GitHub CLI and validates its identity. */
export const readGithubIssue = (issueUrl: string): GithubIssue => {
	const issue = GhIssueSchema.safeParse(runGhJson(['issue', 'view', issueUrl, '--json', 'number,state,title,body,url'], `for ${issueUrl}`));
	if (!issue.success) {
		throw new QueueError(`GitHub returned an invalid issue for ${issueUrl}`);
	}
	if (issue.data.number !== issueNumber(issueUrl) || issue.data.url.replace(/\/$/u, '') !== issueUrl) {
		throw new QueueError(`GitHub returned an invalid issue for ${issueUrl}`);
	}
	return {state: issue.data.state, title: issue.data.title, body: issue.data.body};
};
