import {z} from 'zod';

import {environment} from './environment.ts';
import {QueueError} from './errors.ts';
import {spawnProcessSync} from './platform/spawn.ts';

/** A canonical GitHub issue URL accepted by the queue schema. */
export const GITHUB_ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*\/?$/u;

const GhIssueSchema = z.object({
	number: z.number().int().positive(),
	state: z.enum(['OPEN', 'CLOSED']),
	title: z.string().trim().min(1),
	body: z.string(),
	url: z.string().min(1),
});

/** Issue data required to build an agent prompt. */
export type GithubIssue = {
	readonly state: 'OPEN' | 'CLOSED';
	readonly title: string;
	readonly body: string;
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
	const result = spawnProcessSync(environment.GH_BIN ?? 'gh', ['issue', 'view', issueUrl, '--json', 'number,state,title,body,url'], {encoding: 'utf8'});
	if (result.error) {
		throw new QueueError(`Cannot run gh: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new QueueError(`GitHub CLI failed for ${issueUrl}: ${result.stderr.trim()}`);
	}

	const parsed = ((): unknown => {
		try {
			return JSON.parse(result.stdout);
		} catch (error) {
			throw new QueueError(`GitHub returned invalid JSON for ${issueUrl}`, {cause: error});
		}
	})();
	const issue = GhIssueSchema.safeParse(parsed);
	if (!issue.success) {
		throw new QueueError(`GitHub returned an invalid issue for ${issueUrl}`);
	}
	if (issue.data.number !== issueNumber(issueUrl) || issue.data.url.replace(/\/$/u, '') !== issueUrl) {
		throw new QueueError(`GitHub returned an invalid issue for ${issueUrl}`);
	}
	return {state: issue.data.state, title: issue.data.title, body: issue.data.body};
};
