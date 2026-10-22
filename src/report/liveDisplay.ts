import {clip, formatDuration, sanitize, shorten, terminalWidth} from '../sanitize.ts';
import {type TextWriter} from '../types.ts';

const PREVIEW_LINES = 8;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Transient TTY-only phase and rolling preview display. */
export class LiveDisplay {
	public readonly stream: TextWriter;
	public readonly enabled: boolean;
	private phase = 'starting';
	private readonly started = Date.now();
	private readonly preview: string[] = [];
	private renderedLines = 0;
	private frame = 0;

	public constructor(stream: TextWriter) {
		this.stream = stream;
		this.enabled = stream.isTTY === true;
	}

	/** Changes the displayed phase and redraws the frame. */
	public setPhase(phase: string): void {
		this.phase = phase;
		this.render();
	}

	/** Appends one sanitized preview line and redraws the frame. */
	public add(text: string): void {
		for (const line of sanitize(text).split('\n')) {
			if (line.trim().length > 0) {
				this.preview.push(shorten(line));
			}
		}
		while (this.preview.length > PREVIEW_LINES) {
			this.preview.shift();
		}
		this.render();
	}

	/** Redraws the transient display, if attached to a terminal. */
	public render(): void {
		if (!this.enabled) {
			return;
		}
		this.clearRendered();
		const elapsed = formatDuration((Date.now() - this.started) / 1000);
		const frame = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? '';
		const lines = [`${frame} ${this.phase} · ${elapsed}`, ...this.preview.map((line) => `  ${line}`)];
		this.frame += 1;
		for (const line of lines) {
			this.stream.write(`\u001b[2K${clip(line, terminalWidth())}\n`);
		}
		this.renderedLines = lines.length;
	}

	/** Erases the transient display. */
	public clear(): void {
		if (!this.enabled) {
			return;
		}
		this.clearRendered();
	}

	private clearRendered(): void {
		if (this.renderedLines === 0) {
			return;
		}
		this.stream.write(`\u001b[${String(this.renderedLines)}A`);
		for (let index = 0; index < this.renderedLines; index += 1) {
			this.stream.write('\u001b[2K\n');
		}
		this.stream.write(`\u001b[${String(this.renderedLines)}A`);
		this.renderedLines = 0;
	}
}
