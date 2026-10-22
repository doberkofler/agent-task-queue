import {type ChildProcess} from 'node:child_process';
import {homedir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

import {sleepInhibitorCommand, stopSleepInhibitor} from '../src/platform/sleepInhibitor.ts';
import {describeTool, workspacePath} from '../src/report/activity.ts';
import {AgentReporter} from '../src/report/agentReporter.ts';
import {TerminalProgress, taskTitle, type ProgressEvent} from '../src/report/progress.ts';
import {createPalette} from '../src/report/style.ts';
import {sanitize, shorten} from '../src/sanitize.ts';
import {type QueueItem, type TextWriter} from '../src/types.ts';

const collector = (isTTY = false): {stream: TextWriter; text: () => string} => {
	let output = '';
	return {stream: {isTTY, write: (text: string) => (output += text)}, text: () => output};
};

const item: QueueItem = {issue: 14, description: '#14 [EVAL-006] Runner', position: 0};

const progressFor = (isTTY = false, verbose = false): {progress: TerminalProgress; text: () => string} => {
	const collected = collector(isTTY);
	const progress = new TerminalProgress(collected.stream, {verbose, palette: {forceColor: false}});
	return {progress, text: collected.text};
};

const reportAll = (progress: TerminalProgress, events: readonly ProgressEvent[]): void => {
	for (const event of events) {
		progress.report(event);
	}
};

const reporterFor = (verbose: boolean): {reporter: AgentReporter; text: () => string} => {
	const {progress, text} = progressFor(true, verbose);
	progress.report({type: 'run-started', queue: 'queue.json', model: null, verification: null});
	progress.report({type: 'task-started', item});
	const reporter = new AgentReporter({progress, verbose});
	reporter.start();
	return {reporter, text};
};

const toolPart = (
	tool: string,
	input: Readonly<Record<string, unknown>>,
): {readonly tool: string; readonly state: {readonly input: Readonly<Record<string, unknown>>}} => ({tool, state: {input}});

class FakeInhibitor {
	public exitCode: number | null = null;
	private readonly listeners: (() => void)[] = [];

	public once(event: 'exit' | 'error', listener: () => void): this {
		if (event === 'exit') {
			this.listeners.push(listener);
		}
		return this;
	}

	public kill(): boolean {
		this.exitCode = 0;
		for (const listener of this.listeners) {
			listener();
		}
		return true;
	}
}

describe('TerminalProgress', () => {
	it('renders a compact header without repeating the issue number', () => {
		const {progress, text} = progressFor();
		reportAll(progress, [
			{type: 'run-started', queue: 'milestone-2.json', model: 'deepseek/deepseek-flash', verification: 'pnpm run verify'},
			{type: 'task-started', item},
			{type: 'phase-started', label: 'Agent'},
			{
				type: 'task-finished',
				item,
				stats: {durationSeconds: 128, tools: 12, tokens: 24_100, cost: 0.0842, commit: 'a1b2c3d'},
				summary: ['Implemented ownership tests.', 'Updated testing documentation.', 'Must not appear.'],
			},
		]);
		const output = text();
		expect(output).toContain('RUN  milestone-2.json');
		expect(output).toContain('model deepseek/deepseek-flash');
		expect(output.match(/#14/gu)).toHaveLength(1);
		expect(output).toContain('[EVAL-006] Runner');
		expect(output).toContain('2m08s');
		expect(output).toContain('12 tools');
		expect(output).toContain('24.1k tokens');
		expect(output).toContain('$0.0842');
		expect(output).toContain('commit a1b2c3d');
		expect(output).toContain('Implemented ownership tests.');
		expect(output).toContain('Updated testing documentation.');
		expect(output).not.toContain('Must not appear.');
	});

	it('redraws one transient activity line on a TTY', () => {
		const {progress, text} = progressFor(true);
		reportAll(progress, [
			{type: 'run-started', queue: 'queue.json', model: null, verification: null},
			{type: 'task-started', item},
			{type: 'phase-started', label: 'Agent'},
			{type: 'activity', detail: 'Reading src/report/progress.ts', counters: '3 tools'},
		]);
		const output = text();
		expect(output).toContain('Reading src/report/progress.ts');
		expect(output).toContain('3 tools');
		expect(output).toContain('#14');
		expect(output).toContain('\r\u001b[2K');
		progress.close();
	});

	it('hides activities and keeps milestones when output is piped', () => {
		const {progress, text} = progressFor();
		reportAll(progress, [
			{type: 'run-started', queue: 'queue.json', model: null, verification: null},
			{type: 'phase-started', label: 'Preflight'},
			{type: 'activity', detail: 'noisy command output'},
			{type: 'phase-finished', label: 'Preflight', outcome: {durationSeconds: 29.8}},
			{type: 'task-started', item},
			{type: 'phase-started', label: 'Agent'},
			{type: 'activity', detail: 'Running command'},
			{type: 'task-finished', item, stats: {durationSeconds: 10, tools: 1, tokens: 0, cost: 0, commit: 'abc1234'}, summary: []},
			{type: 'run-finished', completed: 1, durationSeconds: 40},
		]);
		const output = text();
		expect(output).toContain('Preflight');
		expect(output).not.toContain('noisy command output');
		expect(output).not.toContain('Running command');
		expect(output).not.toContain('\u001b');
		expect(output).toContain('1 task completed');
	});

	it('prints a bounded failure block with its log path', () => {
		const {progress, text} = progressFor();
		reportAll(progress, [
			{type: 'run-started', queue: 'queue.json', model: null, verification: null},
			{type: 'task-started', item},
			{type: 'phase-started', label: 'Agent'},
			{
				type: 'failure',
				label: 'Agent',
				outcome: {durationSeconds: 14.4, exitCode: 7},
				logPath: '~/.local/state/agent-task-queue/2026-10-22T124906-39.log',
				tail: ['stdout: boom', 'stderr: details'],
			},
		]);
		const output = text();
		expect(output).toContain('Agent failed (exit 7)');
		expect(output).toContain('~/.local/state/agent-task-queue/2026-10-22T124906-39.log');
		expect(output).toContain('│ stdout: boom');
		expect(output).toContain('│ stderr: details');
		progress.report({type: 'task-aborted'});
		expect(text().match(/#14/gu)).toHaveLength(1);
	});

	it('reports interruptions and verbose diagnostics', () => {
		const {progress, text} = progressFor(true, true);
		reportAll(progress, [
			{type: 'run-started', queue: 'queue.json', model: null, verification: null},
			{type: 'task-started', item},
			{type: 'verbose', text: 'tool shell pnpm test'},
			{type: 'interrupted'},
		]);
		const output = text();
		expect(output).toContain('interrupted; terminating OpenCode');
		expect(output).toContain('tool shell pnpm test');
	});
});

describe('AgentReporter', () => {
	it('reports semantic tool activity and counts finished tools once', () => {
		const {reporter, text} = reporterFor(false);
		const completed = JSON.stringify({type: 'tool_use', part: {id: 'a', tool: 'read', state: {status: 'completed', input: {path: 'src/report/progress.ts'}}}});
		reporter.consume(completed);
		reporter.consume(completed);
		reporter.consume(JSON.stringify({type: 'tool_use', part: {id: 'b', tool: 'shell', state: {status: 'running', input: {command: 'pnpm secret-command'}}}}));
		const output = text();
		expect(output).toContain('Reading src/report/progress.ts');
		expect(output).toContain('Running command');
		expect(output).not.toContain('pnpm secret-command');
		expect(reporter.finish().tools).toBe(1);
	});

	it('accumulates tokens, cost, and the final text', () => {
		const {reporter} = reporterFor(false);
		reporter.consume(JSON.stringify({type: 'step_finish', part: {cost: 0.0012, tokens: {input: 100, output: 20, reasoning: 0}}}));
		reporter.consume(JSON.stringify({type: 'text', part: {text: 'Implemented\nthe runner.'}}));
		const stats = reporter.finish();
		expect(stats.tokens).toBe(120);
		expect(stats.cost).toBeCloseTo(0.0012);
		expect(stats.finalText).toContain('Implemented');
	});

	it('reports errors and detects background jobs', () => {
		const {reporter, text} = reporterFor(false);
		reporter.consume(JSON.stringify({type: 'tool_use', part: {id: 'b', tool: 'shell', state: {status: 'running', input: {background: true}}}}));
		reporter.consume(JSON.stringify({type: 'error', error: {data: {message: 'boom'}}}));
		expect(reporter.backgroundJobStarted).toBe(true);
		expect(text()).toContain('boom');
	});

	it('shows raw diagnostics only in verbose mode', () => {
		const hidden = reporterFor(false);
		hidden.reporter.consume('unstructured diagnostic');
		expect(hidden.text()).not.toContain('unstructured diagnostic');

		const verbose = reporterFor(true);
		verbose.reporter.consume('unstructured diagnostic');
		expect(verbose.text()).toContain('unstructured diagnostic');
	});

	it('strips terminal control sequences', () => {
		const {reporter, text} = reporterFor(false);
		reporter.consume(JSON.stringify({type: 'text', part: {text: '\u001b[31mred\u001b[0m'}}));
		expect(text()).not.toContain('\u001b[31m');
		expect(text()).toContain('red');
	});
});

describe('activity', () => {
	it('describes tools without exposing commands or absolute paths', () => {
		expect(describeTool(toolPart('read', {path: `${process.cwd()}/src/index.ts`}))).toBe('Reading src/index.ts');
		expect(describeTool(toolPart('shell', {command: 'rm -rf /'}))).toBe('Running command');
		expect(describeTool(toolPart('grep', {pattern: 'needle'}))).toBe('Searching for needle');
		expect(describeTool(toolPart('websearch', {query: 'zod v4'}))).toContain('zod v4');
	});

	it('keeps home-relative paths readable', () => {
		const homeFile = path.join(homedir(), 'agent-task-queue-example', 'file.ts');
		expect(workspacePath(homeFile)).toBe('~/agent-task-queue-example/file.ts');
	});
});

describe('taskTitle', () => {
	it('removes a repeated issue prefix', () => {
		expect(taskTitle(item)).toBe('[EVAL-006] Runner');
		expect(taskTitle({issue: 9, description: 'Something', position: 0})).toBe('Something');
	});
});

describe('style', () => {
	const tty: TextWriter = {isTTY: true, write: () => undefined};
	const plain: TextWriter = {write: () => undefined};

	it('uses ANSI styles when enabled', () => {
		expect(createPalette(tty, {forceColor: true}).enabled).toBe(true);
		expect(createPalette(plain, {forceColor: true}).enabled).toBe(true);
	});

	it('disables ANSI styles for plain streams and NO_COLOR', () => {
		expect(createPalette(plain, {forceColor: false}).enabled).toBe(false);
		expect(createPalette(tty, {noColor: true}).enabled).toBe(false);
	});
});

describe('sanitize', () => {
	it('removes control characters and terminal escapes', () => {
		expect(sanitize('\u001b[31mred\u001b[0m\u0007')).toBe('red');
		expect(shorten('  spaced \n text  ', 100)).toBe('spaced text');
	});
});

describe('sleep inhibitor', () => {
	it('uses caffeinate on macOS', () => {
		expect(sleepInhibitorCommand('darwin', '/usr/bin/caffeinate', 42)).toStrictEqual(['/usr/bin/caffeinate', '-i', '-w', '42']);
	});

	it('uses systemd-inhibit on Linux', () => {
		expect(sleepInhibitorCommand('linux', '/usr/bin/systemd-inhibit', 42)).toStrictEqual([
			'/usr/bin/systemd-inhibit',
			'--what=idle',
			'--why=agent-task-queue',
			'--mode=block',
			'sleep',
			'infinity',
		]);
	});

	it('is a no-op without an executable or on unsupported platforms', () => {
		expect(sleepInhibitorCommand('darwin', null, 42)).toBeNull();
		expect(sleepInhibitorCommand('win32', '/bin/x', 42)).toBeNull();
	});

	it('stops a running inhibitor', async () => {
		const inhibitor = new FakeInhibitor();
		await stopSleepInhibitor(inhibitor as unknown as ChildProcess);
		expect(inhibitor.exitCode).toBe(0);
		await stopSleepInhibitor(null);
	});
});
