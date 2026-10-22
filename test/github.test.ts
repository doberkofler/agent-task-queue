import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {NO_COMMIT_AGENT, RECORDING_AGENT, createFixture, runQueue, writeAgent, writeGithubCli, type Fixture} from './helpers/fixtures.ts';
import {commitAll, git, removeTemporaryDirectory, runCli} from './helpers/workspace.ts';

const ISSUE_URL = 'https://github.com/doberkofler/agent-task-queue/issues/16';

describe('github', () => {
	const temporaryDirectories: string[] = [];

	const githubFixture = (): Fixture => {
		const value = createFixture();
		temporaryDirectories.push(value.directory, value.logDirectory);
		writeFileSync(value.queuePath, JSON.stringify({version: 1, kind: 'github-issues', items: [{url: ISSUE_URL}]}), 'utf8');
		return value;
	};

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			removeTemporaryDirectory(directory);
		}
	});

	describe('GitHub issue queues', () => {
		it('processes an open issue and records the closure footer', () => {
			const value = githubFixture();
			const github = writeGithubCli(value.directory, 'OPEN', ISSUE_URL);
			const agent = writeAgent(value.directory, 'agent', RECORDING_AGENT);

			const result = runQueue(value, agent, {env: {GH_BIN: github}});

			expect(result.status).toBe(0);
			const prompt = (JSON.parse(readFileSync(path.join(value.directory, 'argv.json'), 'utf8')) as string[]).at(-1) ?? '';
			expect(prompt).toContain(`GitHub issue: ${ISSUE_URL}`);
			expect(prompt).toContain('Preserve raw events');
			expect(prompt).toContain('Do not close the GitHub issue');
			expect(git(value.directory, 'rev-list', '--count', 'HEAD').stdout.trim()).toBe('3');
			expect(git(value.directory, 'log', '-1', '--format=%B').stdout).toContain('Closes doberkofler/agent-task-queue#16');
			expect(JSON.parse(readFileSync(value.queuePath, 'utf8'))).toStrictEqual({version: 1, kind: 'github-issues', items: [{url: ISSUE_URL}]});
		});

		it('reads a closed stdin queue without starting the agent', () => {
			const value = createFixture();
			temporaryDirectories.push(value.directory, value.logDirectory);
			const github = writeGithubCli(value.directory, 'CLOSED', ISSUE_URL);
			const agent = writeAgent(value.directory, 'agent', 'process.exit(99);\n');

			const result = runCli({
				cwd: value.directory,
				args: ['--no-verify', '-'],
				env: {GH_BIN: github, OPENCODE_BIN: agent, QUEUE_LOG_DIR: value.logDirectory},
				input: JSON.stringify({version: 1, kind: 'github-issues', items: [{url: ISSUE_URL}]}),
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain('[run] 0 completed');
			expect(() => readFileSync(path.join(value.directory, 'argv.json'), 'utf8')).toThrow('ENOENT');
		});

		it('skips issues with local completion commits without GitHub access', () => {
			const value = githubFixture();
			const agent = writeAgent(value.directory, 'agent', 'process.exit(99);\n');
			git(value.directory, 'commit', '--allow-empty', '-m', 'chore: mark done: #16', '-m', 'Closes doberkofler/agent-task-queue#16');

			const result = runQueue(value, agent, {env: {GH_BIN: '/nonexistent/gh'}});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain('[run] 0 completed');
			expect(() => readFileSync(path.join(value.directory, 'argv.json'), 'utf8')).toThrow('ENOENT');
		});

		it('requires commit-backed completion for GitHub queues', () => {
			const value = githubFixture();
			const agent = writeAgent(value.directory, 'agent', NO_COMMIT_AGENT);
			const configPath = path.join(value.directory, 'agent-task-queue.config.json');
			writeFileSync(configPath, JSON.stringify({repository: {requireCleanTree: false}, completion: {commit: false}}), 'utf8');
			commitAll(value.directory, 'test: add configuration');

			const result = runCli({
				cwd: value.directory,
				args: ['--config', configPath, '--no-verify', value.queuePath],
				env: {OPENCODE_BIN: agent, QUEUE_LOG_DIR: value.logDirectory},
			});

			expect(result.status).toBe(1);
			expect(result.stderr).toContain('GitHub issue queues require completion.commit true');
		});
	});
});
