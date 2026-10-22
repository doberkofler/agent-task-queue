import {LiveDisplay} from './liveDisplay.ts';
import {summarizeTool} from './toolSummary.ts';
import {readField, readNumber, readString} from '../jsonValue.ts';
import {clip, formatDuration, sanitize, shorten} from '../sanitize.ts';
import {type QueueItem, type RunLogs, type TextWriter} from '../types.ts';

const MAX_PREVIEW_LINES = 20;
const MAX_PREVIEW_LINE_LENGTH = 400;

const symbolFor = (status: string): string => (status === 'completed' ? '✓' : status === 'error' ? '✗' : status === 'running' ? '…' : '•');
const isFinished = (status: string): boolean => status === 'completed' || status === 'error';

/** Options for one run reporter. */
export type RunReporterOptions = {
	readonly model: string | null;
	readonly agentName: string;
	readonly verbose: boolean;
	readonly stream: TextWriter;
	readonly live?: LiveDisplay;
};

/** Renders agent progress and records token, tool, and cost totals. */
export class RunReporter {
	public readonly model: string | null;
	public readonly agentName: string;
	public readonly verbose: boolean;
	public readonly stream: TextWriter;
	public readonly live: LiveDisplay;
	public readonly started = Date.now();
	public toolCalls = 0;
	public tokens = 0;
	public cost = 0;
	public finalText = '';
	public backgroundJobStarted = false;
	private readonly seenTools = new Set<string>();

	public constructor(options: RunReporterOptions) {
		this.model = options.model;
		this.agentName = options.agentName;
		this.verbose = options.verbose;
		this.stream = options.stream;
		this.live = options.live ?? new LiveDisplay(options.stream);
	}

	private timestamp(): string {
		const elapsed = Math.trunc((Date.now() - this.started) / 1000);
		return `[${String(Math.trunc(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}]`;
	}

	private write(text: string): void {
		this.stream.write(`${text}\n`);
	}

	private addTransient(message: string): void {
		if (this.live.enabled) {
			this.live.add(message);
		} else {
			this.write(`${this.timestamp()} ${message}`);
		}
	}

	/** Writes the run header and the log locations. */
	public start(item: QueueItem, logs: RunLogs): void {
		this.write(`[queue] ${item.description}`);
		this.write(`[agent] ${this.agentName} · ${this.model ?? 'default model'}`);
		this.write(`[log] ${logs.history}`);
		this.write(`[agent-log] ${logs.agent}`);
		this.live.setPhase('agent');
	}

	private message(label: string, text: string): void {
		const lines = sanitize(text).replace(/\n$/u, '').split('\n');
		if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
			return;
		}
		if (label === 'agent') {
			this.finalText = sanitize(text).trim();
		}
		if (this.live.enabled) {
			this.live.add(`${label} › ${lines.at(-1) ?? ''}`);
			return;
		}
		const prefix = `${this.timestamp()} ${label} › `;
		const visible = lines.slice(0, MAX_PREVIEW_LINES);
		for (const [index, line] of visible.entries()) {
			const preview = clip(line, MAX_PREVIEW_LINE_LENGTH);
			this.write(index === 0 ? prefix + preview : ' '.repeat(prefix.length) + preview);
		}
		if (lines.length > visible.length) {
			this.write(`${' '.repeat(prefix.length)}… ${String(lines.length - visible.length)} more lines (see log)`);
		}
	}

	private tool(part: unknown): void {
		const state = readField(part, 'state');
		const status = readString(state, 'status') || 'unknown';
		if (readField(readField(state, 'input'), 'background') === true) {
			this.backgroundJobStarted = true;
		}
		const finished = isFinished(status);
		const identifier = readString(part, 'id');
		if (finished && identifier.length > 0) {
			if (this.seenTools.has(identifier)) {
				return;
			}
			this.seenTools.add(identifier);
		}
		if (finished) {
			this.toolCalls += 1;
		}

		let message = `${symbolFor(status)} ${summarizeTool(part)}`;
		const error = readString(state, 'error');
		if (status === 'error' && error.length > 0) {
			message += `: ${shorten(error, 200)}`;
		}
		this.addTransient(message);
	}

	private stepFinish(part: unknown): void {
		const tokens = readField(part, 'tokens');
		for (const key of ['input', 'output', 'reasoning']) {
			const value = readNumber(tokens, key);
			if (value !== undefined && Number.isInteger(value)) {
				this.tokens += value;
			}
		}
		const cost = readNumber(part, 'cost');
		if (cost !== undefined) {
			this.cost += cost;
		}
	}

	private error(event: unknown): void {
		const error = readField(event, 'error');
		const data = readField(error, 'data');
		const message = readString(data, 'message') || readString(error, 'message') || readString(error, 'name') || (typeof error === 'string' ? error : '');
		this.message('error', message || 'OpenCode reported an error');
	}

	/** Consumes one stdout line from the agent process. */
	public consume(line: string): void {
		const stripped = line.trim();
		if (stripped.length === 0) {
			return;
		}
		const parsed = ((): unknown => {
			try {
				return JSON.parse(stripped);
			} catch {
				return undefined;
			}
		})();
		if (parsed === undefined) {
			if (this.verbose) {
				this.addTransient(`log: ${shorten(stripped)}`);
			}
			return;
		}
		const kind = readString(parsed, 'type');
		const part = readField(parsed, 'part');
		if (kind === 'text') {
			const text = readField(part, 'text');
			if (typeof text === 'string') {
				this.message('agent', text);
			}
			return;
		}
		if (kind === 'tool_use') {
			this.tool(part);
			return;
		}
		if (kind === 'step_finish') {
			this.stepFinish(part);
			return;
		}
		if (kind === 'error') {
			this.error(parsed);
			return;
		}
		if (this.verbose) {
			this.addTransient(`event: ${shorten(kind)}`);
		}
	}

	/** Reports that the run was interrupted by a signal. */
	public interrupted(): void {
		this.live.clear();
		this.write('[queue] interrupted; terminating OpenCode');
	}

	/** Writes the final status line and a bounded agent summary. */
	public finish(returnCode: number): void {
		this.live.clear();
		const elapsed = (Date.now() - this.started) / 1000;
		const details = [formatDuration(elapsed)];
		if (this.toolCalls) {
			details.push(`${String(this.toolCalls)} tool${this.toolCalls === 1 ? '' : 's'}`);
		}
		if (this.tokens) {
			details.push(`${this.tokens.toLocaleString('en-US')} tokens`);
		}
		if (this.cost) {
			details.push(`$${this.cost.toFixed(4)}`);
		}
		this.write(`[agent] ${returnCode === 0 ? 'finished' : `failed (exit ${String(returnCode)})`} in ${details.join(' · ')}`);
		this.writeSummary();
	}

	private writeSummary(): void {
		if (this.finalText.length === 0) {
			return;
		}
		const lines = this.finalText.split('\n');
		for (const [index, line] of lines.slice(0, MAX_PREVIEW_LINES).entries()) {
			this.write(`${index === 0 ? '[summary] ' : '          '}${clip(line, MAX_PREVIEW_LINE_LENGTH)}`);
		}
		if (lines.length > MAX_PREVIEW_LINES) {
			this.write(`          … ${String(lines.length - MAX_PREVIEW_LINES)} more lines (see log)`);
		}
	}
}
