import {clip, formatDuration, sanitize, shorten, terminalWidth} from '../sanitize.ts';
import {type TextWriter} from '../types.ts';
import {createPalette, paintEvent, type Palette, type PaletteOptions} from './style.ts';

const PREVIEW_LINES = 8;
const INDENT = '  ';
const CLOCK_INTERVAL_MS = 100;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Transient TTY-only phase and rolling preview display. */
export class LiveDisplay {
	public readonly stream: TextWriter;
	public readonly enabled: boolean;
	public readonly palette: Palette;
	private phase = 'starting';
	private readonly started = Date.now();
	private readonly preview: string[] = [];
	private renderedLines = 0;
	private frame = 0;
	private clock: ReturnType<typeof setInterval> | null = null;

	public constructor(stream: TextWriter, options: PaletteOptions = {}) {
		this.stream = stream;
		this.enabled = stream.isTTY === true;
		this.palette = createPalette(stream, options);
	}

	/** Changes the displayed phase and redraws the frame. */
	public setPhase(phase: string): void {
		this.phase = phase;
		this.startClock();
		this.render();
	}

	/** Appends one sanitized preview line and redraws the frame. */
	public add(text: string): void {
		const width = Math.max(1, terminalWidth() - INDENT.length);
		for (const line of sanitize(text).split('\n')) {
			if (line.trim().length > 0) {
				this.preview.push(shorten(line, width));
			}
		}
		while (this.preview.length > PREVIEW_LINES) {
			this.preview.shift();
		}
		this.startClock();
		this.render();
	}

	/** Redraws the transient display, if attached to a terminal. */
	public render(): void {
		if (!this.enabled) {
			return;
		}
		this.clearRendered();
		const {palette} = this;
		const elapsed = formatDuration((Date.now() - this.started) / 1000);
		const frame = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? '';
		const header = `${palette.cyan(frame)} ${palette.bold(this.phase)} ${palette.dim('·')} ${palette.dim(elapsed)}`;
		const width = Math.max(1, terminalWidth() - INDENT.length);
		const lines = [header, ...this.preview.map((line) => paintEvent(palette, clip(line, width)))];
		this.frame += 1;
		for (const line of lines) {
			this.stream.write(`\u001b[2K${INDENT}${line}\n`);
		}
		this.renderedLines = lines.length;
	}

	/** Erases the transient display. */
	public clear(): void {
		if (!this.enabled) {
			return;
		}
		this.stopClock();
		this.clearRendered();
	}

	private startClock(): void {
		if (!this.enabled || this.clock !== null) {
			return;
		}
		this.clock = setInterval(() => {
			this.render();
		}, CLOCK_INTERVAL_MS);
		this.clock.unref();
	}

	private stopClock(): void {
		if (this.clock === null) {
			return;
		}
		clearInterval(this.clock);
		this.clock = null;
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
