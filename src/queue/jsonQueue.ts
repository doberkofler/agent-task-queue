import {readFileSync} from 'node:fs';
import {z} from 'zod';

import {QueueError} from '../errors.ts';
import {runGit} from '../git.ts';
import {atomicWrite} from '../logFiles.ts';
import {type Queue, type QueueItem, type QueueKind} from '../types.ts';
import {parseJsonContent} from './json.ts';

const JsonQueueSchema = z.looseObject({
	items: z.array(z.unknown()),
});

const JsonQueueItemSchema = z.looseObject({
	issue: z.number().int().positive(),
	evaluation: z.string().trim().min(1),
	title: z.string().trim().min(1),
	done: z.boolean(),
});

type JsonQueueDocument = z.infer<typeof JsonQueueSchema>;

const invalidItem = (position: number, error: z.ZodError): QueueError => {
	const field = error.issues[0]?.path.join('.') ?? 'shape';
	return new QueueError(`JSON queue item ${String(position + 1)} has an invalid ${field}`);
};

/** Legacy JSON queue that preserves unknown document and item fields. */
export class JsonQueue implements Queue {
	public readonly kind: QueueKind = 'json';
	public readonly path: string;
	public readonly document: JsonQueueDocument;
	private readonly commitCompletion: boolean;
	private readonly cwd: string;
	private readonly values: readonly unknown[];
	private readonly items: readonly {item: QueueItem; done: boolean}[];

	public constructor(path: string, parsed?: unknown, commitCompletion = true, cwd = process.cwd()) {
		this.path = path;
		this.commitCompletion = commitCompletion;
		this.cwd = cwd;
		const document = JsonQueueSchema.safeParse(parsed === undefined ? parseJsonContent(readFileSync(path, 'utf8')) : parsed);
		if (!document.success) {
			throw new QueueError('JSON queue must be an object containing an "items" array');
		}
		this.document = document.data;
		this.values = this.document.items;
		this.items = this.parseItems();
	}

	private parseItems(): readonly {item: QueueItem; done: boolean}[] {
		const items: {item: QueueItem; done: boolean}[] = [];
		const issues = new Set<number>();
		for (const [position, value] of this.values.entries()) {
			const parsed = JsonQueueItemSchema.safeParse(value);
			if (!parsed.success) {
				throw invalidItem(position, parsed.error);
			}
			const parsedItem = parsed.data;
			if (issues.has(parsedItem.issue)) {
				throw new QueueError(`Duplicate issue #${String(parsedItem.issue)}`);
			}
			issues.add(parsedItem.issue);
			items.push({
				item: {issue: parsedItem.issue, description: `#${String(parsedItem.issue)} [${parsedItem.evaluation}] ${parsedItem.title}`, position},
				done: parsedItem.done,
			});
		}
		return items;
	}

	public nextItem(): QueueItem | null {
		return this.items.find(({done}) => !done)?.item ?? null;
	}

	private markDone(item: QueueItem): void {
		const value = this.values[item.position];
		const parsed = JsonQueueItemSchema.safeParse(value);
		if (!parsed.success || parsed.data.done || typeof value !== 'object' || value === null) {
			throw new QueueError(`Queue item #${String(item.issue)} changed while it was running`);
		}
		Object.assign(value, {done: true});
		atomicWrite(this.path, `${JSON.stringify(this.document, undefined, 2)}\n`);
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
