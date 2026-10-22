import {z} from 'zod';

import {QueueError} from '../errors.ts';
import {githubClosureReference, hasCompletionCommit, runGit} from '../git.ts';
import {GITHUB_ISSUE_URL_PATTERN, readGithubIssue} from '../githubIssues.ts';
import {type Queue, type QueueItem, type QueueKind} from '../types.ts';

const GithubQueueSchema = z.strictObject({
	version: z.literal(1),
	kind: z.literal('github-issues'),
	items: z.array(z.strictObject({url: z.string().regex(GITHUB_ISSUE_URL_PATTERN)})),
});

type GithubQueueDocument = z.infer<typeof GithubQueueSchema>;
type PendingItem = QueueItem & {readonly sourceUrl: string};

/** GitHub queue completion options. */
export type GithubQueueOptions = {
	readonly commitCompletion?: boolean;
	readonly closeIssueOnCommit?: boolean;
	readonly cwd?: string;
};

const INVALID_QUEUE = 'GitHub queue must be {"version": 1, "kind": "github-issues", "items": [{"url": ...}]}';

/** GitHub issue queue; completion is recorded by a commit, not by the file. */
export class GithubQueue implements Queue {
	public readonly kind: QueueKind = 'github-issues';
	public readonly path: string | null;
	public readonly items: readonly PendingItem[];
	private readonly commitCompletion: boolean;
	private readonly closeIssueOnCommit: boolean;
	private readonly cwd: string;

	public constructor(path: string | null, parsed: unknown, options: GithubQueueOptions = {}) {
		this.path = path;
		const document = GithubQueueSchema.safeParse(parsed);
		if (!document.success) {
			throw new QueueError(INVALID_QUEUE);
		}
		this.items = GithubQueue.parseItems(document.data);
		this.commitCompletion = options.commitCompletion ?? true;
		this.closeIssueOnCommit = options.closeIssueOnCommit ?? true;
		this.cwd = options.cwd ?? process.cwd();
	}

	private static parseItems(document: GithubQueueDocument): readonly PendingItem[] {
		const items: PendingItem[] = [];
		const urls = new Set<string>();
		for (const [position, value] of document.items.entries()) {
			const sourceUrl = value.url.replace(/\/$/u, '');
			if (urls.has(sourceUrl)) {
				throw new QueueError(`Duplicate GitHub issue URL: ${sourceUrl}`);
			}
			urls.add(sourceUrl);
			const issueText = /\/(?<issue>[1-9]\d*)$/u.exec(sourceUrl)?.groups?.['issue'];
			if (issueText === undefined) {
				throw new QueueError(`Invalid GitHub issue URL: ${sourceUrl}`);
			}
			const issue = Number(issueText);
			items.push({issue, description: `#${String(issue)}`, position, sourceUrl});
		}
		return items;
	}

	public nextItem(): QueueItem | null {
		for (const item of this.items) {
			if (hasCompletionCommit(item.sourceUrl, this.cwd)) {
				continue;
			}
			const issue = readGithubIssue(item.sourceUrl);
			if (issue.state === 'CLOSED') {
				continue;
			}
			return {
				issue: item.issue,
				description: `#${String(item.issue)} ${issue.title}`,
				position: item.position,
				sourceUrl: item.sourceUrl,
				details: issue.body,
			};
		}
		return null;
	}

	public commitDone(item: QueueItem): void {
		if (item.sourceUrl === undefined) {
			throw new QueueError(`GitHub queue item #${String(item.issue)} has no source URL`);
		}
		if (!this.commitCompletion) {
			throw new QueueError('GitHub issue queues require completion.commit true');
		}
		const reference = githubClosureReference(item.sourceUrl);
		const footer = this.closeIssueOnCommit ? [`Closes ${reference}`] : [];
		runGit(['commit', '--allow-empty', '-m', `chore: mark done: ${item.description}`, ...footer.flatMap((line) => ['-m', line])], this.cwd);
	}
}
