import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {RECORDING_AGENT, createFixture, writeAgent, type Fixture} from './helpers/fixtures.ts';
import {removeTemporaryDirectory, runCli, type RunCliResult} from './helpers/workspace.ts';

const COUNTER_SCRIPT = `import {existsSync, readFileSync, writeFileSync} from 'node:fs';

const path = process.argv[2];
const count = existsSync(path) ? Number(readFileSync(path, 'utf8')) + 1 : 1;
writeFileSync(path, String(count));
if (process.argv[3] === 'fail-second' && count === 2) {
  process.exit(9);
}
`;

describe('verification', () => {
	const temporaryDirectories: string[] = [];

	const verificationFixture = (): Fixture & {
		readonly counterPath: string;
		readonly scriptPath: string;
		readonly configPath: string;
	} => {
		const value = createFixture();
		temporaryDirectories.push(value.directory, value.logDirectory);
		const counterPath = path.join(value.logDirectory, 'verify-count.txt');
		const scriptPath = path.join(value.logDirectory, 'counter.mjs');
		writeFileSync(scriptPath, COUNTER_SCRIPT, 'utf8');
		const configPath = path.join(value.directory, 'agent-task-queue.config.json');
		return {...value, counterPath, scriptPath, configPath};
	};

	type VerificationFixture = ReturnType<typeof verificationFixture>;

	const configure = (value: VerificationFixture, command: readonly string[], extra: Readonly<Record<string, unknown>> = {}): void => {
		writeFileSync(value.configPath, JSON.stringify({verification: {command, ...extra}}), 'utf8');
	};

	const runVerified = (value: VerificationFixture, agent: string): RunCliResult =>
		runCli({
			cwd: value.directory,
			args: ['--config', value.configPath, value.queuePath],
			env: {OPENCODE_BIN: agent, QUEUE_LOG_DIR: value.logDirectory},
		});

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			removeTemporaryDirectory(directory);
		}
	});

	describe('verification', () => {
		it('requires an explicit verification policy', () => {
			const value = verificationFixture();
			const agent = writeAgent(value.directory, 'agent', RECORDING_AGENT);

			const result = runCli({cwd: value.directory, args: [value.queuePath], env: {OPENCODE_BIN: agent, QUEUE_LOG_DIR: value.logDirectory}});

			expect(result.status).toBe(2);
			expect(result.stderr).toContain('--verify or --no-verify is required');
		});

		it('verifies before the agent and after its commit', () => {
			const value = verificationFixture();
			configure(value, [process.execPath, value.scriptPath, value.counterPath]);
			const agent = writeAgent(value.directory, 'agent', RECORDING_AGENT);

			const result = runVerified(value, agent);

			expect(result.status).toBe(0);
			expect(readFileSync(value.counterPath, 'utf8')).toBe('2');
			expect(result.stdout).toContain('RUN');
			expect(result.stdout).toContain(value.queuePath);
			expect(result.stdout).toMatch(/model\s+default/u);
			expect(result.stdout).toContain(`${process.execPath} ${value.scriptPath} ${value.counterPath}`);
			expect(result.stdout).toMatch(/-preflight\.log/u);
			expect(result.stdout.indexOf('verify preflight passed')).toBeLessThan(result.stdout.indexOf('#14'));
			expect(result.stdout).toContain('verify post-commit passed');
		});

		it('does not start the agent when preflight fails', () => {
			const value = verificationFixture();
			configure(value, [process.execPath, '-e', 'process.exit(9)']);
			const agent = writeAgent(value.directory, 'agent', RECORDING_AGENT);

			const result = runVerified(value, agent);

			expect(result.status).toBe(1);
			expect(result.stdout).toContain('verify preflight failed (exit 9)');
			expect(() => readFileSync(path.join(value.directory, 'argv.json'), 'utf8')).toThrow('ENOENT');
		});

		it('does not start the agent when preflight times out', () => {
			const value = verificationFixture();
			configure(value, [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], {timeoutSeconds: 0.2});
			const agent = writeAgent(value.directory, 'agent', RECORDING_AGENT);

			const result = runVerified(value, agent);

			expect(result.status).toBe(1);
			expect(result.stdout).toContain('preflight timed out');
			expect(() => readFileSync(path.join(value.directory, 'argv.json'), 'utf8')).toThrow('ENOENT');
		});

		it('preserves the queue when post-commit verification fails', () => {
			const value = verificationFixture();
			configure(value, [process.execPath, value.scriptPath, value.counterPath, 'fail-second']);
			const agent = writeAgent(value.directory, 'agent', RECORDING_AGENT);

			const result = runVerified(value, agent);

			expect(result.status).toBe(1);
			expect(result.stdout).toContain('verify post-commit failed (exit 9)');
			const queue = JSON.parse(readFileSync(value.queuePath, 'utf8')) as {items: {done: boolean}[]};
			expect(queue.items[0]?.done).toBe(false);
		});

		it('accepts a shell verification command from the terminal', () => {
			const value = verificationFixture();
			const agent = writeAgent(value.directory, 'agent', RECORDING_AGENT);

			const result = runCli({
				cwd: value.directory,
				args: ['--verify', `${JSON.stringify(process.execPath)} ${JSON.stringify(value.scriptPath)} ${JSON.stringify(value.counterPath)}`, value.queuePath],
				env: {OPENCODE_BIN: agent, QUEUE_LOG_DIR: value.logDirectory},
			});

			expect(result.status).toBe(0);
			expect(readFileSync(value.counterPath, 'utf8')).toBe('2');
		});

		it('rejects mutually exclusive verification flags', () => {
			const value = verificationFixture();
			const agent = writeAgent(value.directory, 'agent', RECORDING_AGENT);

			const result = runCli({
				cwd: value.directory,
				args: ['--verify', 'true', '--no-verify', value.queuePath],
				env: {OPENCODE_BIN: agent, QUEUE_LOG_DIR: value.logDirectory},
			});

			expect(result.status).toBe(2);
			expect(result.stderr).toContain('mutually exclusive');
		});
	});
});
