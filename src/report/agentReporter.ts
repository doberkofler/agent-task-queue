import {readField, readNumber, readString} from '../jsonValue.ts';
import {sanitize, shorten} from '../sanitize.ts';
import {describeTool, describeToolVerbose} from './activity.ts';
import {type TerminalProgress} from './progress.ts';

/** Token, cost, and tool totals accumulated from one agent stream. */
export type AgentStats = {
	readonly tools: number;
	readonly tokens: number;
	readonly cost: number;
	readonly finalText: string;
};

/** Inputs for translating one OpenCode event stream into progress. */
export type AgentReporterOptions = {
	readonly progress: TerminalProgress;
	readonly verbose: boolean;
};

const plural = (count: number, singular: string): string => `${String(count)} ${singular}${count === 1 ? '' : 's'}`;
const isFinished = (status: string): boolean => status === 'completed' || status === 'error';

/** Consumes OpenCode JSON events and reports semantic activity instead of tool arguments. */
export class AgentReporter {
	public readonly progress: TerminalProgress;
	public readonly verbose: boolean;
	public backgroundJobStarted = false;
	public toolCalls = 0;
	public tokens = 0;
	public cost = 0;
	public finalText = '';
	private readonly seenTools = new Set<string>();

	public constructor(options: AgentReporterOptions) {
		this.progress = options.progress;
		this.verbose = options.verbose;
	}

	/** Starts the agent phase. */
	public start(): void {
		this.progress.report({type: 'phase-started', label: 'Agent'});
	}

	private activity(detail: string): void {
		const counters = this.toolCalls === 0 ? '' : plural(this.toolCalls, 'tool');
		this.progress.report({type: 'activity', detail, ...(counters.length === 0 ? {} : {counters})});
	}

	private tool(part: unknown): void {
		const state = readField(part, 'state');
		const status = readString(state, 'status') || 'running';
		if (readField(readField(state, 'input'), 'background') === true) {
			this.backgroundJobStarted = true;
		}
		const identifier = readString(part, 'id');
		if (isFinished(status) && identifier.length > 0) {
			if (this.seenTools.has(identifier)) {
				return;
			}
			this.seenTools.add(identifier);
			this.toolCalls += 1;
		}
		if (this.verbose) {
			this.progress.report({type: 'verbose', text: `tool ${describeToolVerbose(part)}`});
		}
		this.activity(describeTool(part));
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
		this.progress.report({type: 'note', level: 'error', text: message || 'OpenCode reported an error'});
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
				this.progress.report({type: 'verbose', text: `log ${shorten(stripped)}`});
			}
			return;
		}
		const kind = readString(parsed, 'type');
		const part = readField(parsed, 'part');
		if (kind === 'text') {
			const text = readField(part, 'text');
			if (typeof text === 'string') {
				this.finalText = sanitize(text).trim();
				const lastLine = this.finalText.split('\n').findLast((candidate) => candidate.trim().length > 0) ?? this.finalText;
				this.activity(lastLine.trim());
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
			this.progress.report({type: 'verbose', text: `event ${shorten(kind)}`});
		}
	}

	/** Returns the accumulated stream totals. */
	public finish(): AgentStats {
		return {tools: this.toolCalls, tokens: this.tokens, cost: this.cost, finalText: this.finalText};
	}
}
