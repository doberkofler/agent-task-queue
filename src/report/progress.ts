import {clip, formatDuration, sanitize, shorten, terminalWidth} from '../sanitize.ts';
import {type QueueItem, type TextWriter} from '../types.ts';
import {createPalette, type Palette, type PaletteOptions} from './style.ts';

const CLOCK_INTERVAL_MS = 100;
const SUMMARY_LINES = 2;
const TAIL_LINE_LENGTH = 400;
const ACTIVITY_INDENT = '   ';
const DETAIL_INDENT = '     ';
const LOG_INDENT = '   ';
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Outcome details for one finished phase. */
export type PhaseOutcome = {
	readonly durationSeconds: number;
	readonly exitCode?: number;
	readonly timedOut?: boolean;
};

/** Totals reported when one task completes. */
export type TaskStats = {
	readonly durationSeconds: number;
	readonly tools: number;
	readonly tokens: number;
	readonly cost: number;
	readonly commit: string | null;
};

/** Options shared by every terminal progress renderer. */
export type ProgressOptions = {
	readonly verbose?: boolean;
	readonly palette?: PaletteOptions;
};

/** One observable unit of run progress. */
export type ProgressEvent =
	| {readonly type: 'run-started'; readonly queue: string; readonly model: string | null; readonly verification: string | null}
	| {readonly type: 'phase-started'; readonly label: string}
	| {readonly type: 'activity'; readonly detail: string; readonly counters?: string}
	| {readonly type: 'phase-finished'; readonly label: string; readonly outcome: PhaseOutcome}
	| {readonly type: 'phase-skipped'; readonly label: string; readonly reason: string}
	| {readonly type: 'task-started'; readonly item: QueueItem}
	| {readonly type: 'task-finished'; readonly item: QueueItem; readonly stats: TaskStats; readonly summary: readonly string[]}
	| {readonly type: 'task-aborted'}
	| {
			readonly type: 'failure';
			readonly label: string;
			readonly outcome: PhaseOutcome;
			readonly logPath?: string;
			readonly tail?: readonly string[];
	  }
	| {readonly type: 'note'; readonly level: 'error' | 'warning'; readonly text: string}
	| {readonly type: 'verbose'; readonly text: string}
	| {readonly type: 'interrupted'}
	| {readonly type: 'run-finished'; readonly completed: number; readonly durationSeconds: number};

const plural = (count: number, singular: string): string => `${String(count)} ${singular}${count === 1 ? '' : 's'}`;

const formatTokens = (tokens: number): string => {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}m`;
	}
	if (tokens >= 1000) {
		return `${(tokens / 1000).toFixed(1)}k`;
	}
	return String(tokens);
};

/** Removes a leading `#N` when a queue description already repeats the issue number. */
export const taskTitle = (item: QueueItem): string => {
	const prefix = `#${String(item.issue)}`;
	const description = item.description.trim();
	if (description.startsWith(`${prefix} `)) {
		return description.slice(prefix.length + 1).trim();
	}
	return description;
};

const outcomeText = (label: string, outcome: PhaseOutcome): string => {
	if (outcome.timedOut === true) {
		return `${label} timed out`;
	}
	if (outcome.exitCode !== undefined && outcome.exitCode !== 0) {
		return `${label} failed (exit ${String(outcome.exitCode)})`;
	}
	return `${label} failed`;
};

/**
 * Renders run progress for one terminal stream.
 *
 * On a TTY, a stable summary row and a semantic activity row are rendered
 * independently; completed work is appended as compact permanent lines. On a
 * pipe, activities are dropped and only phase and task milestones are written.
 */
export class TerminalProgress {
	public readonly stream: TextWriter;
	public readonly palette: Palette;
	public readonly interactive: boolean;
	public readonly verbose: boolean;
	private task: QueueItem | null = null;
	private taskFailed = false;
	private phaseLabel = '';
	private detail = '';
	private counters = '';
	private phaseStarted = Date.now();
	private activityDrawn = false;
	private lastLineBlank = false;
	private frame = 0;
	private clock: ReturnType<typeof setInterval> | null = null;
	private closed = false;

	public constructor(stream: TextWriter, options: ProgressOptions = {}) {
		this.stream = stream;
		this.verbose = options.verbose ?? false;
		this.interactive = stream.isTTY === true;
		this.palette = createPalette(stream, options.palette ?? {});
	}

	/** Applies one progress event. */
	public report(event: ProgressEvent): void {
		if (this.applyRunEvent(event)) {
			return;
		}
		this.applyPhaseEvent(event);
	}

	private applyRunEvent(event: ProgressEvent): boolean {
		if (event.type === 'run-started') {
			this.runStarted(event);
			return true;
		}
		if (event.type === 'task-started') {
			this.startTask(event.item);
			return true;
		}
		if (event.type === 'task-finished') {
			this.finishTask(event.item, event.stats, event.summary);
			return true;
		}
		if (event.type === 'task-aborted') {
			this.abortTask();
			return true;
		}
		if (event.type === 'failure') {
			this.writeFailure(event);
			return true;
		}
		if (event.type === 'note') {
			this.writeNote(event.level, event.text);
			return true;
		}
		if (event.type === 'verbose') {
			if (this.verbose) {
				this.line(`   ${this.palette.dim(shorten(event.text))}`);
			}
			return true;
		}
		if (event.type === 'interrupted') {
			this.writeInterrupted();
			return true;
		}
		if (event.type === 'run-finished') {
			this.finishRun(event.completed, event.durationSeconds);
			return true;
		}
		return false;
	}

	private applyPhaseEvent(event: ProgressEvent): void {
		if (event.type === 'phase-started') {
			this.startPhase(event.label);
			return;
		}
		if (event.type === 'activity') {
			this.detail = sanitize(event.detail);
			this.counters = event.counters ?? '';
			this.renderSummary();
			this.renderDetail();
			return;
		}
		if (event.type === 'phase-finished') {
			this.finishPhase(event.label, event.outcome);
			return;
		}
		if (event.type === 'phase-skipped') {
			this.skipPhase(event.label, event.reason);
		}
	}

	/** Stops the activity clock and erases the transient line. */
	public close(): void {
		this.closed = true;
		this.endActivity();
	}

	private runStarted(event: Extract<ProgressEvent, {type: 'run-started'}>): void {
		const {palette} = this;
		this.line(` ${palette.cyan(palette.bold('RUN'))}  ${palette.bold(event.queue)}`);
		this.line(`      ${palette.dim('model')} ${event.model ?? 'default'} ${palette.dim('·')} ${palette.dim('verify')} ${event.verification ?? 'disabled'}`);
		this.blank();
	}

	private startPhase(label: string): void {
		this.phaseLabel = label;
		this.detail = '';
		this.counters = '';
		this.phaseStarted = Date.now();
		this.renderActivity();
	}

	private finishPhase(label: string, outcome: PhaseOutcome): void {
		this.endActivity();
		if (this.task !== null) {
			return;
		}
		this.blank();
		this.line(` ${this.palette.green('✓')} ${label} ${this.palette.dim('·')} ${this.palette.dim(formatDuration(outcome.durationSeconds))}`);
	}

	private skipPhase(label: string, reason: string): void {
		this.endActivity();
		this.blank();
		this.line(` ${this.palette.yellow('↓')} ${label} skipped ${this.palette.dim(`(${reason})`)}`);
	}

	private startTask(item: QueueItem): void {
		this.endActivity();
		this.task = item;
		this.taskFailed = false;
		this.blank();
		this.phaseLabel = 'Waiting';
		this.detail = '';
		this.counters = '';
		this.phaseStarted = Date.now();
		this.renderActivity();
	}

	private finishTask(item: QueueItem, stats: TaskStats, summary: readonly string[]): void {
		this.endActivity();
		this.blank();
		const {palette} = this;
		const width = terminalWidth();
		const title = shorten(taskTitle(item), width - 6);
		this.line(` ${palette.green('✓')} ${palette.bold(`#${String(item.issue)}`)} ${title}`);
		const details = [palette.dim(formatDuration(stats.durationSeconds))];
		if (stats.tools > 0) {
			details.push(palette.dim(plural(stats.tools, 'tool')));
		}
		if (stats.tokens > 0) {
			details.push(palette.dim(`${formatTokens(stats.tokens)} tokens`));
		}
		if (stats.cost > 0) {
			details.push(palette.dim(`$${stats.cost.toFixed(4)}`));
		}
		if (stats.commit !== null) {
			details.push(palette.dim(`commit ${palette.cyan(stats.commit)}`));
		}
		this.line(`${LOG_INDENT}${details.join(palette.dim(' · '))}`);
		const visible = summary
			.map((line) => sanitize(line).trim())
			.filter((line) => line.length > 0 && !/^#{1,6}\s/u.test(line) && !line.startsWith('```'))
			.slice(0, SUMMARY_LINES);
		if (visible.length > 0) {
			this.blank();
			for (const line of visible) {
				this.line(`${LOG_INDENT}${shorten(line, width - LOG_INDENT.length)}`);
			}
		}
		this.blank();
		this.task = null;
	}

	private abortTask(): void {
		this.endActivity();
		const item = this.task;
		if (item === null) {
			return;
		}
		this.task = null;
		if (this.taskFailed) {
			return;
		}
		this.blank();
		this.line(` ${this.palette.red('✗')} ${this.palette.bold(`#${String(item.issue)}`)} ${shorten(taskTitle(item), terminalWidth() - 6)}`);
		this.blank();
	}

	private writeFailure(event: Extract<ProgressEvent, {type: 'failure'}>): void {
		this.endActivity();
		this.blank();
		const {palette} = this;
		const width = terminalWidth();
		const item = this.task;
		const description = outcomeText(event.label, event.outcome);
		if (item === null) {
			this.line(` ${palette.red('✗')} ${palette.red(description)} ${palette.dim('·')} ${palette.dim(formatDuration(event.outcome.durationSeconds))}`);
		} else {
			this.taskFailed = true;
			this.task = null;
			this.line(` ${palette.red('✗')} ${palette.bold(`#${String(item.issue)}`)} ${shorten(taskTitle(item), width - 6)}`);
			this.line(`${LOG_INDENT}${palette.red(description)} ${palette.dim('·')} ${palette.dim(formatDuration(event.outcome.durationSeconds))}`);
		}
		if (event.logPath !== undefined) {
			this.line(`${LOG_INDENT}${palette.dim('log')}  ${shorten(event.logPath, width - 8)}`);
		}
		const tail = event.tail ?? [];
		if (tail.length > 0) {
			this.blank();
			for (const line of tail) {
				this.line(`${LOG_INDENT}${palette.dim('│')} ${clip(sanitize(line), Math.min(TAIL_LINE_LENGTH, width - 5))}`);
			}
		}
		this.blank();
	}

	private writeNote(level: 'error' | 'warning', text: string): void {
		const symbol = level === 'error' ? this.palette.red('✗') : this.palette.yellow('!');
		this.line(` ${symbol} ${level === 'error' ? this.palette.red(shorten(text)) : this.palette.yellow(shorten(text))}`);
	}

	private writeInterrupted(): void {
		this.endActivity();
		this.blank();
		this.line(` ${this.palette.yellow('!')} interrupted; terminating OpenCode`);
		this.blank();
		this.task = null;
	}

	private finishRun(completed: number, durationSeconds: number): void {
		this.endActivity();
		this.blank();
		const text = completed === 0 ? 'no pending tasks' : `${plural(completed, 'task')} completed`;
		this.line(` ${this.palette.green('✓')} ${this.palette.bold(text)} ${this.palette.dim('·')} ${this.palette.dim(formatDuration(durationSeconds))}`);
		this.blank();
	}

	private line(text: string): void {
		if (text.length === 0) {
			this.blank();
			return;
		}
		this.clearActivity();
		this.stream.write(`${text}\n`);
		this.lastLineBlank = false;
		this.renderActivity();
	}

	private blank(): void {
		if (this.lastLineBlank) {
			return;
		}
		this.clearActivity();
		this.stream.write('\n');
		this.lastLineBlank = true;
		this.renderActivity();
	}

	private renderActivity(): void {
		if (!this.interactive || this.closed || this.phaseLabel.length === 0) {
			return;
		}
		if (!this.activityDrawn) {
			this.stream.write(`\r\u001b[2K${this.summaryRow()}\n${this.detailRow()}`);
			this.activityDrawn = true;
			this.frame += 1;
			this.startClock();
			return;
		}
		this.renderSummary();
		this.renderDetail();
	}

	private summaryRow(): string {
		const {palette} = this;
		const elapsed = formatDuration((Date.now() - this.phaseStarted) / 1000);
		const frame = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? '';
		const identity = this.task === null ? palette.bold(this.phaseLabel) : palette.bold(`#${String(this.task.issue)}`);
		const segments = [
			`${ACTIVITY_INDENT}${palette.cyan(frame)} ${identity}`,
			this.counters.length === 0 ? '' : palette.dim(this.counters),
			palette.dim(elapsed),
		].filter((part) => part.length > 0);
		return segments.join(` ${palette.dim('·')} `);
	}

	private detailRow(): string {
		const {palette} = this;
		const phase = this.task === null ? '' : this.phaseLabel;
		const plainPrefix = `${DETAIL_INDENT}${phase}`;
		const separatorLength = phase.length > 0 && this.detail.length > 0 ? 3 : 0;
		const detail = clip(this.detail, Math.max(0, terminalWidth() - plainPrefix.length - separatorLength));
		const segments = [phase.length === 0 ? '' : palette.dim(phase), detail].filter((part) => part.length > 0);
		return `${DETAIL_INDENT}${segments.join(` ${palette.dim('·')} `)}`;
	}

	private renderSummary(): void {
		if (!this.interactive || this.closed || this.phaseLabel.length === 0) {
			return;
		}
		if (!this.activityDrawn) {
			this.renderActivity();
			return;
		}
		this.stream.write(`\u001b[1A\r\u001b[2K${this.summaryRow()}\u001b[1B\r`);
		this.frame += 1;
	}

	private renderDetail(): void {
		if (!this.interactive || this.closed || this.phaseLabel.length === 0) {
			return;
		}
		if (!this.activityDrawn) {
			this.renderActivity();
			return;
		}
		this.stream.write(`\r\u001b[2K${this.detailRow()}`);
	}

	private clearActivity(): void {
		if (!this.interactive || !this.activityDrawn) {
			return;
		}
		this.stream.write('\r\u001b[2K\u001b[1A\r\u001b[2K');
		this.activityDrawn = false;
	}

	private endActivity(): void {
		this.clearActivity();
		this.stopClock();
		this.phaseLabel = '';
		this.detail = '';
		this.counters = '';
	}

	private startClock(): void {
		if (!this.interactive || this.clock !== null) {
			return;
		}
		this.clock = setInterval(() => {
			this.renderSummary();
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
}
