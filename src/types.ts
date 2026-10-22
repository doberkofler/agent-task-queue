/** One runnable entry from a queue source. */
export type QueueItem = {
	readonly issue: number;
	readonly description: string;
	readonly position: number;
	readonly sourceUrl?: string;
	readonly details?: string;
};

/** Queue formats understood by the runner. */
export type QueueKind = 'markdown' | 'json' | 'github-issues';

/** A mutable queue that persists completion after each validated item. */
export type Queue = {
	readonly kind: QueueKind;
	readonly nextItem: () => Promise<QueueItem | null> | QueueItem | null;
	readonly commitDone: (item: QueueItem) => Promise<void> | void;
};

/** Paths of the two logs written for one agent or verification run. */
export type RunLogs = {
	readonly agent: string;
	readonly history: string;
};

/** A character-oriented output sink used by the reporter. */
export type TextWriter = {
	readonly write: (text: string) => unknown;
	readonly isTTY?: boolean;
};

/** Agent commit validation policies. */
export type CommitPolicy = 'exactly-one' | 'at-least-one' | 'none';
