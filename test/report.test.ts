import {type ChildProcess} from 'node:child_process';
import {describe, expect, it} from 'vitest';

import {sleepInhibitorCommand, stopSleepInhibitor} from '../src/platform/sleepInhibitor.ts';
import {RunReporter} from '../src/report/reporter.ts';
import {createPalette, paintEvent} from '../src/report/style.ts';
import {sanitize, shorten} from '../src/sanitize.ts';
import {type TextWriter} from '../src/types.ts';

const collector = (): {stream: TextWriter; text: () => string} => {
	let output = '';
	return {stream: {write: (text: string) => (output += text)}, text: () => output};
};

const reporterFor = (verbose: boolean): {reporter: RunReporter; text: () => string} => {
	const collected = collector();
	return {reporter: new RunReporter({model: 'deepseek/deepseek-flash', agentName: 'build', verbose, stream: collected.stream}), text: collected.text};
};

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

describe('RunReporter', () => {
	it('shows unstructured output in verbose mode', () => {
		const {reporter, text} = reporterFor(true);
		reporter.consume('unstructured diagnostic');
		expect(text()).toContain('unstructured diagnostic');
	});

	it('hides unstructured output by default', () => {
		const {reporter, text} = reporterFor(false);
		reporter.consume('unstructured diagnostic');
		expect(text()).toBe('');
	});

	it('strips terminal control sequences', () => {
		const {reporter, text} = reporterFor(false);
		reporter.consume(JSON.stringify({type: 'text', part: {text: '\u001b[31mred\u001b[0m'}}));
		expect(text()).not.toContain('\u001b');
		expect(text()).toContain('red');
	});

	it('summarizes tools, tokens, cost, and the final text', () => {
		const {reporter, text} = reporterFor(false);
		reporter.consume(JSON.stringify({type: 'tool_use', part: {id: 'a', tool: 'shell', state: {status: 'completed', input: {command: 'pnpm test'}}}}));
		reporter.consume(JSON.stringify({type: 'tool_use', part: {id: 'a', tool: 'shell', state: {status: 'completed', input: {command: 'pnpm test'}}}}));
		reporter.consume(JSON.stringify({type: 'step_finish', part: {cost: 0.0012, tokens: {input: 100, output: 20, reasoning: 0}}}));
		reporter.consume(JSON.stringify({type: 'text', part: {text: 'Implemented\nthe runner.'}}));
		reporter.finish(0);
		expect(text()).toContain('✓ shell pnpm test');
		expect(text()).toContain('1 tool');
		expect(text()).toContain('120 tokens');
		expect(text()).toContain('$0.0012');
		expect(text()).toContain('Summary');
		expect(text()).toContain('Implemented');
	});

	it('reports failures and background jobs', () => {
		const {reporter, text} = reporterFor(false);
		reporter.consume(JSON.stringify({type: 'tool_use', part: {id: 'b', tool: 'shell', state: {status: 'running', input: {background: true}}}}));
		reporter.consume(JSON.stringify({type: 'error', error: {data: {message: 'boom'}}}));
		reporter.finish(7);
		expect(reporter.backgroundJobStarted).toBe(true);
		expect(text()).toContain('agent failed (exit 7)');
		expect(text()).toContain('error › boom');
	});

	it('renders transient live frames on a TTY', () => {
		let output = '';
		const stream: TextWriter = {isTTY: true, write: (text: string) => (output += text)};
		const reporter = new RunReporter({model: null, agentName: 'build', verbose: false, stream});
		reporter.consume(JSON.stringify({type: 'tool_use', part: {id: 'c', tool: 'read', state: {status: 'completed', input: {path: 'README.md'}}}}));
		reporter.interrupted();
		expect(output).toContain('read README.md');
		expect(output).toContain('interrupted; terminating OpenCode');
		expect(output).toContain('\u001b[');
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

	it('paints status symbols and labels', () => {
		const palette = createPalette(tty, {forceColor: true});
		expect(paintEvent(palette, '✓ read README.md')).toBe(`${palette.green('✓')} read README.md`);
		expect(paintEvent(palette, '✗ failed')).toBe(palette.red('✗ failed'));
		expect(paintEvent(palette, 'agent › working')).toBe(`${palette.dim('agent')}${palette.dim(' › ')}working`);
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
