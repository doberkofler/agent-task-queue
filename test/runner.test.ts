import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {afterEach, describe, expect, it} from 'vitest';

import {
	BACKGROUND_AGENT,
	NO_COMMIT_AGENT,
	RECORDING_AGENT,
	SIGNAL_AGENT,
	SLEEP_AGENT,
	UNSTRUCTURED_AGENT,
	createFixture,
	eventAgent,
	runQueue,
	writeAgent,
	type Fixture,
} from './helpers/fixtures.ts';
import {cliEnvironment, cliExecutable, git, removeTemporaryDirectory} from './helpers/workspace.ts';

const temporaryDirectories: string[] = [];

const fixture = (): Fixture => {
	const value = createFixture();
	temporaryDirectories.push(value.directory, value.logDirectory);
	return value;
};

const waitFor = async (predicate: () => boolean, milliseconds = 10_000): Promise<void> => {
	const deadline = Date.now() + milliseconds;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await delay(50);
	}
	throw new Error('Timed out waiting for condition');
};

const pidIsAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

type SignalResult = {
	readonly code: number | null;
	readonly stderr: string;
	readonly stdout: string;
};

const runWithSignal = async (signal: NodeJS.Signals): Promise<SignalResult> => {
	const value = fixture();
	const agent = writeAgent(value.directory, 'agent', SIGNAL_AGENT);
	const child = spawn(process.execPath, [cliExecutable, '--no-verify', '--queue-file', value.queuePath], {
		cwd: value.directory,
		env: cliEnvironment({OPENCODE_BIN: agent, QUEUE_LOG_DIR: value.logDirectory}),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr.on('data', (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const pidPath = path.join(value.directory, 'agent.pid');
	await waitFor(() => existsSync(pidPath));
	const agentPid = Number(readFileSync(pidPath, 'utf8'));
	child.kill(signal);
	const [code] = (await once(child, 'exit')) as [number | null];
	await waitFor(() => !pidIsAlive(agentPid));
	return {code, stderr, stdout};
};

describe('runner', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			removeTemporaryDirectory(directory);
		}
	});

	it('runs the build agent and commits completion', () => {
		const value = fixture();
		const agent = writeAgent(value.directory, 'agent', RECORDING_AGENT);

		const result = runQueue(value, agent);

		expect(result.status).toBe(0);
		const argv = JSON.parse(readFileSync(path.join(value.directory, 'argv.json'), 'utf8')) as string[];
		expect(argv.slice(0, 7)).toStrictEqual(['run', '--standalone', '--auto', '--agent', 'build', '--format', 'json']);
		expect(argv).not.toContain('--model');
		const prompt = readFileSync(path.join(value.directory, 'prompt.txt'), 'utf8');
		expect(prompt).toContain('Implement exactly this item');
		expect(prompt).toContain(`Do not modify the queue file: ${value.queuePath}`);
		expect(prompt).toContain('Do not start background jobs');
		const queue = JSON.parse(readFileSync(value.queuePath, 'utf8')) as {items: {done: boolean}[]};
		expect(queue.items[0]?.done).toBe(true);
		expect(git(value.directory, 'rev-list', '--count', 'HEAD').stdout.trim()).toBe('3');
	});

	it('passes an explicit model', () => {
		const value = fixture();
		const agent = writeAgent(value.directory, 'agent', RECORDING_AGENT);

		const result = runQueue(value, agent, {args: ['--model', 'openai/gpt-5.6-sol']});

		expect(result.status).toBe(0);
		const argv = JSON.parse(readFileSync(path.join(value.directory, 'argv.json'), 'utf8')) as string[];
		expect(argv.slice(7, 9)).toStrictEqual(['--model', 'openai/gpt-5.6-sol']);
	});

	it('reads the model from the environment', () => {
		const value = fixture();
		const agent = writeAgent(value.directory, 'agent', RECORDING_AGENT);

		const result = runQueue(value, agent, {env: {QUEUE_MODEL: 'ollama/qwen3.8:27b-mlx'}});

		expect(result.status).toBe(0);
		const argv = JSON.parse(readFileSync(path.join(value.directory, 'argv.json'), 'utf8')) as string[];
		expect(argv.slice(7, 9)).toStrictEqual(['--model', 'ollama/qwen3.8:27b-mlx']);
	});

	it('rejects an agent that does not commit', () => {
		const value = fixture();
		const agent = writeAgent(value.directory, 'agent', NO_COMMIT_AGENT);

		const result = runQueue(value, agent);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Agent must create exactly one non-merge commit');
		const queue = JSON.parse(readFileSync(value.queuePath, 'utf8')) as {items: {done: boolean}[]};
		expect(queue.items[0]?.done).toBe(false);
	});

	it('rejects an agent that starts a background job', () => {
		const value = fixture();
		const agent = writeAgent(value.directory, 'agent', BACKGROUND_AGENT);

		const result = runQueue(value, agent);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Agent started a background job');
		const queue = JSON.parse(readFileSync(value.queuePath, 'utf8')) as {items: {done: boolean}[]};
		expect(queue.items[0]?.done).toBe(false);
	});

	it('renders progress and writes the raw log', () => {
		const value = fixture();
		const agent = writeAgent(value.directory, 'agent', eventAgent());

		const result = runQueue(value, agent);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('RUN');
		expect(result.stdout).toContain(value.queuePath);
		expect(result.stdout).toMatch(/model\s+default/u);
		expect(result.stdout).toMatch(/verify\s+disabled/u);
		expect(result.stdout).toContain('✓ #14 [EVAL-006] Runner');
		expect(result.stdout).toContain('2 tools');
		expect(result.stdout).toContain('120 tokens');
		expect(result.stdout).toContain('$0.0012');
		expect(result.stdout).toContain('1 task completed');
		expect(result.stdout).toContain('Implemented');
		expect(result.stdout).toContain('the runner.');
		expect(result.stdout).not.toContain('✓ shell pnpm test');
		expect(result.stdout).not.toContain('Running command');
		expect(result.stdout).not.toContain('"type"');
		expect(result.stderr).not.toContain('"type"');

		const agentLogs = readdirSync(value.logDirectory).filter((name) => name.endsWith('.jsonl'));
		expect(agentLogs).toHaveLength(1);
		const agentLog = readFileSync(path.join(value.logDirectory, agentLogs[0] ?? ''), 'utf8');
		expect(agentLog).toContain('"type":"tool_use"');
		expect(agentLog).not.toContain('agent diagnostic');

		const historyLogs = readdirSync(value.logDirectory).filter((name) => name.endsWith('.log'));
		expect(historyLogs).toHaveLength(1);
		const historyPath = path.join(value.logDirectory, historyLogs[0] ?? '');
		expect(readFileSync(historyPath, 'utf8')).toContain('agent diagnostic');
		expect(result.stdout).not.toContain(historyPath);
		expect(result.stdout).not.toContain(path.join(value.logDirectory, agentLogs[0] ?? ''));
	});

	it('reports an agent failure with the log path', () => {
		const value = fixture();
		const agent = writeAgent(value.directory, 'agent', eventAgent(7));

		const result = runQueue(value, agent);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain('Agent failed (exit 7)');
		expect(result.stderr).toContain('OpenCode exited with status 7');
		const historyLogs = readdirSync(value.logDirectory).filter((name) => name.endsWith('.log'));
		expect(historyLogs).toHaveLength(1);
		expect(result.stdout).toContain(historyLogs[0] ?? '');
		expect(result.stdout).not.toContain('✓ #14');
	});

	it('hides unstructured output by default and shows it in verbose mode', () => {
		const hidden = fixture();
		const hiddenAgent = writeAgent(hidden.directory, 'agent', UNSTRUCTURED_AGENT);
		const hiddenResult = runQueue(hidden, hiddenAgent);
		expect(hiddenResult.status).toBe(0);
		expect(hiddenResult.stdout).not.toContain('unstructured diagnostic');

		const verbose = fixture();
		const verboseAgent = writeAgent(verbose.directory, 'agent', UNSTRUCTURED_AGENT);
		const verboseResult = runQueue(verbose, verboseAgent, {args: ['--verbose']});
		expect(verboseResult.status).toBe(0);
		expect(verboseResult.stdout).toContain('unstructured diagnostic');
		expect(verboseResult.stdout).toContain(verbose.logDirectory);
	});

	it('times out and terminates the agent process group', () => {
		const value = fixture();
		const agent = writeAgent(value.directory, 'agent', SLEEP_AGENT);

		const result = runQueue(value, agent, {args: ['--timeout', '1']});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('timed out');
		const agentPid = Number(readFileSync(path.join(value.directory, 'agent.pid'), 'utf8'));
		const childPid = Number(readFileSync(path.join(value.directory, 'child.pid'), 'utf8'));
		expect(process.platform === 'win32' || (!pidIsAlive(agentPid) && !pidIsAlive(childPid))).toBe(true);
	});

	it.skipIf(process.platform === 'win32')('interrupts cleanly on SIGINT', async () => {
		const result = await runWithSignal('SIGINT');
		expect(result.code).toBe(130);
		expect(result.stderr).toContain('agent-task-queue: interrupted');
		expect(result.stderr).not.toContain('Traceback');
		expect(result.stdout).toContain('interrupted; terminating OpenCode');
	});

	it.skipIf(process.platform === 'win32')('terminates cleanly on SIGTERM', async () => {
		const result = await runWithSignal('SIGTERM');
		expect(result.code).toBe(143);
		expect(result.stderr).toContain('agent-task-queue: terminated');
		expect(result.stderr).not.toContain('Traceback');
	});
});
