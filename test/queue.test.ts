import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {QueueError} from '../src/errors.ts';
import {GithubQueue} from '../src/queue/githubQueue.ts';
import {JsonQueue} from '../src/queue/jsonQueue.ts';
import {loadQueue} from '../src/queue/loadQueue.ts';
import {MarkdownQueue} from '../src/queue/markdownQueue.ts';
import {promptFor} from '../src/prompt.ts';
import {commitAll, createTemporaryDirectory, git, initializeRepository, removeTemporaryDirectory} from './helpers/workspace.ts';

describe('queue', () => {
	const temporaryDirectories: string[] = [];

	const temporaryRepository = (): string => {
		const directory = createTemporaryDirectory();
		temporaryDirectories.push(directory);
		initializeRepository(directory);
		return directory;
	};

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			removeTemporaryDirectory(directory);
		}
	});

	describe('MarkdownQueue', () => {
		it('marks the first unchecked item without changing other content', () => {
			const directory = temporaryRepository();
			const queuePath = path.join(directory, 'queue.md');
			writeFileSync(queuePath, 'heading\n- [x] #1 completed\n- [ ] #2 [EVAL-002] title with `code` & /\n', 'utf8');
			commitAll(directory, 'test: initialize fixture');

			const queue = new MarkdownQueue(queuePath, true, directory);
			const item = queue.nextItem();
			if (item === null) {
				throw new Error('Expected a pending item');
			}
			queue.commitDone(item);
			expect(readFileSync(queuePath, 'utf8')).toBe('heading\n- [x] #1 completed\n- [x] #2 [EVAL-002] title with `code` & /\n');
			expect(git(directory, 'log', '-1', '--format=%s').stdout.trim()).toBe('chore: mark done: #2 [EVAL-002] title with `code` & /');
		});

		it('preserves CRLF line endings', () => {
			const directory = temporaryRepository();
			const queuePath = path.join(directory, 'queue.md');
			writeFileSync(queuePath, 'heading\r\n- [ ] #3 First\r\n', 'utf8');
			commitAll(directory, 'test: initialize fixture');
			const queue = new MarkdownQueue(queuePath, true, directory);
			const item = queue.nextItem();
			if (item === null) {
				throw new Error('Expected a pending item');
			}
			queue.commitDone(item);
			expect(readFileSync(queuePath, 'utf8')).toBe('heading\r\n- [x] #3 First\r\n');
		});

		it('rejects duplicate issues', () => {
			const directory = temporaryRepository();
			const queuePath = path.join(directory, 'queue.md');
			writeFileSync(queuePath, '- [ ] #1 first\n- [ ] #1 duplicate\n', 'utf8');
			expect(() => new MarkdownQueue(queuePath)).toThrow('Duplicate issue #1');
		});

		it('rejects malformed checklist lines', () => {
			const directory = temporaryRepository();
			const queuePath = path.join(directory, 'queue.md');
			writeFileSync(queuePath, '- [?] broken\n', 'utf8');
			expect(() => new MarkdownQueue(queuePath)).toThrow('Malformed Markdown queue item');
		});
	});

	describe('JsonQueue', () => {
		it('marks an item done and preserves extra fields', () => {
			const directory = temporaryRepository();
			const queuePath = path.join(directory, 'queue.json');
			writeFileSync(queuePath, '{"name":"milestone","items":[{"issue":14,"evaluation":"EVAL-006","title":"Runner","done":false,"owner":"team"}]}', 'utf8');
			commitAll(directory, 'test: initialize fixture');

			const queue = new JsonQueue(queuePath, undefined, true, directory);
			const item = queue.nextItem();
			if (item === null) {
				throw new Error('Expected a pending item');
			}
			queue.commitDone(item);

			const reloaded = new JsonQueue(queuePath, undefined, true, directory);
			expect(reloaded.nextItem()).toBeNull();
			expect(reloaded.document['name']).toBe('milestone');
			const first = reloaded.document.items[0] as Record<string, unknown>;
			expect(first['owner']).toBe('team');
			expect(first['done']).toBe(true);
		});

		it('rejects a non-boolean done value', () => {
			const directory = temporaryRepository();
			const queuePath = path.join(directory, 'queue.json');
			writeFileSync(queuePath, '{"items":[{"issue":1,"evaluation":"EVAL-001","title":"Title","done":0}]}', 'utf8');
			expect(() => new JsonQueue(queuePath)).toThrow('invalid done');
		});
	});

	describe('GithubQueue', () => {
		const issueUrl = 'https://github.com/doberkofler/agent-task-queue/issues/16';

		it('parses canonical issue URLs', () => {
			const directory = temporaryRepository();
			const queue = new GithubQueue(path.join(directory, 'queue.json'), {version: 1, kind: 'github-issues', items: [{url: issueUrl}]}, {cwd: directory});
			expect(queue.items[0]?.issue).toBe(16);
			expect(queue.items[0]?.sourceUrl).toBe(issueUrl);
		});

		it('rejects copied or ambiguous issue state', () => {
			expect(() => new GithubQueue(null, {version: 1, kind: 'github-issues', items: [{url: issueUrl, done: false}]})).toThrow('GitHub queue must be');
		});

		it('rejects a boolean version', () => {
			expect(() => new GithubQueue(null, {version: true, kind: 'github-issues', items: []})).toThrow('GitHub queue must be');
		});

		it('rejects duplicate URLs after canonicalization', () => {
			expect(() => new GithubQueue(null, {version: 1, kind: 'github-issues', items: [{url: issueUrl}, {url: `${issueUrl}/`}]})).toThrow(
				'Duplicate GitHub issue URL',
			);
		});

		it('rejects a non-GitHub URL', () => {
			expect(() => new GithubQueue(null, {version: 1, kind: 'github-issues', items: [{url: 'https://example.com/issues/1'}]})).toThrow('GitHub queue must be');
		});
	});

	describe('loadQueue', () => {
		it('rejects an unknown extension', () => {
			expect(() => loadQueue('queue.jsonc')).toThrow('.md or .json');
		});

		it('rejects stdin content without the GitHub kind', () => {
			expect(() => loadQueue(null, '{"items":[]}')).toThrow('stdin requires a JSON queue');
		});

		it('rejects an unsupported JSON kind', () => {
			const directory = temporaryRepository();
			const queuePath = path.join(directory, 'queue.json');
			writeFileSync(queuePath, '{"kind":"other","items":[]}', 'utf8');
			expect(() => loadQueue(queuePath)).toThrow('Unsupported JSON queue kind');
		});

		it('reports invalid JSON', () => {
			const directory = temporaryRepository();
			const queuePath = path.join(directory, 'queue.json');
			writeFileSync(queuePath, '{', 'utf8');
			expect(() => loadQueue(queuePath)).toThrow('Invalid JSON queue');
		});

		it('reports a queue contract error with the QueueError type', () => {
			expect(() => loadQueue('queue.txt')).toThrow(QueueError);
		});
	});

	describe('promptFor', () => {
		it('requires verification and one commit', () => {
			const directory = temporaryRepository();
			const queuePath = path.join(directory, 'queue.md');
			writeFileSync(queuePath, '- [ ] #14 [EVAL-006] Runner\n', 'utf8');
			const item = new MarkdownQueue(queuePath, true, directory).nextItem();
			const prompt = promptFor({issue: 14, description: '#14 [EVAL-006] Runner', position: 0}, queuePath, 'exactly-one');
			expect(item).not.toBeNull();
			expect(prompt).toContain('Run tests/lint/typecheck');
			expect(prompt).toContain('Make exactly one commit');
			expect(prompt).toContain(`Do not modify the queue file: ${queuePath}`);
			expect(prompt).not.toContain('GitHub issue');
		});

		it('describes the no-commit policy', () => {
			const prompt = promptFor({issue: 1, description: '#1 task', position: 0}, null, 'none');
			expect(prompt).toContain('Do not create commits');
			expect(prompt).toContain('read-only stdin');
		});
	});
});
