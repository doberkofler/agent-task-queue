/** Fixed-size rolling tail of recent log lines. */
export class LineTail {
	private readonly limit: number;
	private readonly lines: string[] = [];

	public constructor(limit: number) {
		this.limit = limit;
	}

	/** Appends one line, discarding the oldest entry beyond the limit. */
	public add(line: string): void {
		this.lines.push(line);
		if (this.lines.length > this.limit) {
			this.lines.shift();
		}
	}

	/** Returns the retained lines in chronological order. */
	public values(): readonly string[] {
		return this.lines;
	}

	/** Reports whether any line was retained. */
	public get empty(): boolean {
		return this.lines.length === 0;
	}
}
