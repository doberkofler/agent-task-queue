import {readFileSync} from 'node:fs';

import {QueueError} from '../errors.ts';
import {runGit} from '../git.ts';
import {atomicWrite} from '../logFiles.ts';
import {type Queue, type QueueItem, type QueueKind} from '../types.ts';

const MARKDOWN_ITEM = /^- \[(?<done>[ x])\] #(?<issue>[1-9]\d*) (?<title>\S.*)$/iu;

/** Markdown checklist queue with `- [ ] #N title` entries. */
export class MarkdownQueue implements Queue {
	public readonly kind: QueueKind = 'markdown';
	public readonly path: string;
	private readonly commitCompletion: boolean;
	private readonly cwd: string;
	private readonly lines: string[];
	private readonly items: readonly {item: QueueItem; done: boolean}[];

	public constructor(path: string, commitCompletion = true, cwd = process.cwd()) {
		this.path = path;
		this.commitCompletion = commitCompletion;
		this.cwd = cwd;
		const content = readFileSync(path, 'utf8');
		this.lines = content.split(/(?<=\n)/u);
		this.items = this.parseItems();
	}

	private parseItems(): readonly {item: QueueItem; done: boolean}[] {
		const items: {item: QueueItem; done: boolean}[] = [];
		const issues = new Set<number>();
		for (const [position, line] of this.lines.entries()) {
			const candidate = line.replace(/\r?\n$/u, '');
			if (!candidate.startsWith('- [')) {
				continue;
			}
			const match = MARKDOWN_ITEM.exec(candidate);
			const issueText = match?.groups?.['issue'];
			const title = match?.groups?.['title'];
			const done = match?.groups?.['done'];
			if (issueText === undefined || title === undefined || done === undefined) {
				throw new QueueError(`Malformed Markdown queue item on line ${String(position + 1)}`);
			}
			const issue = Number(issueText);
			if (issues.has(issue)) {
				throw new QueueError(`Duplicate issue #${String(issue)}`);
			}
			issues.add(issue);
			items.push({item: {issue, description: `#${String(issue)} ${title}`, position}, done: done !== ' '});
		}
		return items;
	}

	public nextItem(): QueueItem | null {
		return this.items.find(({done}) => !done)?.item ?? null;
	}

	private markDone(item: QueueItem): void {
		const line = this.lines[item.position];
		if (line === undefined || !line.startsWith('- [ ] ')) {
			throw new QueueError(`Queue item #${String(item.issue)} changed while it was running`);
		}
		this.lines[item.position] = `- [x] ${line.slice('- [ ] '.length)}`;
		atomicWrite(this.path, this.lines.join(''));
	}

	public commitDone(item: QueueItem): void {
		this.markDone(item);
		if (!this.commitCompletion) {
			return;
		}
		runGit(['add', '--', this.path], this.cwd);
		runGit(['commit', '-m', `chore: mark done: ${item.description}`], this.cwd);
	}
}
