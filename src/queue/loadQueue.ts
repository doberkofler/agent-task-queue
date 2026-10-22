import {readFileSync} from 'node:fs';

import {QueueError} from '../errors.ts';
import {type Queue} from '../types.ts';
import {GithubQueue, type GithubQueueOptions} from './githubQueue.ts';
import {parseJsonContent} from './json.ts';
import {JsonQueue} from './jsonQueue.ts';
import {MarkdownQueue} from './markdownQueue.ts';

/** Completion behavior shared by all queue formats. */
export type LoadQueueOptions = {
	readonly commitCompletion?: boolean;
	readonly closeIssueOnCommit?: boolean;
	readonly cwd?: string;
};

const githubOptions = (options: LoadQueueOptions): GithubQueueOptions => ({
	commitCompletion: options.commitCompletion ?? true,
	closeIssueOnCommit: options.closeIssueOnCommit ?? true,
	...(options.cwd === undefined ? {} : {cwd: options.cwd}),
});

const isGithubDocument = (value: unknown): boolean => typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'github-issues';

const loadFromContent = (content: string, options: LoadQueueOptions): Queue => {
	const parsed = parseJsonContent(content);
	if (isGithubDocument(parsed)) {
		return new GithubQueue(null, parsed, githubOptions(options));
	}
	throw new QueueError('stdin requires a JSON queue with kind "github-issues"');
};

const loadFromJsonFile = (path: string, options: LoadQueueOptions): Queue => {
	const parsed = parseJsonContent(readFileSync(path, 'utf8'));
	if (typeof parsed === 'object' && parsed !== null && 'kind' in parsed) {
		if (parsed.kind === 'github-issues') {
			return new GithubQueue(path, parsed, githubOptions(options));
		}
		throw new QueueError(`Unsupported JSON queue kind: ${String(parsed.kind)}`);
	}
	return new JsonQueue(path, parsed, options.commitCompletion ?? true, options.cwd ?? process.cwd());
};

/** Loads a Markdown, legacy JSON, or GitHub issue queue. */
export const loadQueue = (path: string | null, content: string | null = null, options: LoadQueueOptions = {}): Queue => {
	if (path === null) {
		if (content === null) {
			throw new QueueError('Missing stdin queue content');
		}
		return loadFromContent(content, options);
	}
	if (path.toLowerCase().endsWith('.md')) {
		return new MarkdownQueue(path, options.commitCompletion ?? true, options.cwd ?? process.cwd());
	}
	if (path.toLowerCase().endsWith('.json')) {
		return loadFromJsonFile(path, options);
	}
	throw new QueueError('Queue must have a .md or .json extension');
};
