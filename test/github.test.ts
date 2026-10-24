import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {NO_COMMIT_AGENT, RECORDING_AGENT, createFixture, runQueue, writeAgent, writeGithubCli, type Fixture} from './helpers/fixtures.ts';
import {commitAll, git, removeTemporaryDirectory, runCli, writeExecutable} from './helpers/workspace.ts';

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
		it('resolves a numeric issue against the current repository', () => {
			const value = createFixture();
			temporaryDirectories.push(value.directory, value.logDirectory);
			const github = writeExecutable(
				value.directory,
				'fake-gh',
				`const args = process.argv.slice(2);
if (args[0] === 'repo') {
  console.log(JSON.stringify({url: 'https://github.com/doberkofler/agent-task-queue'}));
} else {
  console.log(JSON.stringify({number: 16, state: 'CLOSED', title: 'Done', body: '', url: '${ISSUE_URL}'}));
}
`,
			);
			const agent = writeAgent(value.directory, 'agent', 'process.exit(99);\n');

			const result = runCli({
				cwd: value.directory,
				args: ['--github-issues', '16', '--no-verify'],
				env: {GH_BIN: github, OPENCODE_BIN: agent, QUEUE_LOG_DIR: value.logDirectory},
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain('no pending tasks');
		});

		it('loads milestone issues in number order and excludes pull requests', () => {
			const value = createFixture();
			temporaryDirectories.push(value.directory, value.logDirectory);
			const callsPath = path.join(value.logDirectory, 'gh-calls.jsonl');
			const issue17 = 'https://github.com/doberkofler/agent-task-queue/issues/17';
			const pullRequest = 'https://github.com/doberkofler/agent-task-queue/issues/15';
			const github = writeExecutable(
				value.directory,
				'fake-gh',
				`import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  console.log(JSON.stringify([[
    {number: 17, html_url: '${issue17}'},
    {number: 15, html_url: '${pullRequest}', pull_request: {}},
    {number: 16, html_url: '${ISSUE_URL}'}
  ]]));
} else {
  const url = args[2];
  const number = Number(url.split('/').at(-1));
  console.log(JSON.stringify({number, state: 'CLOSED', title: 'Done', body: '', url}));
}
`,
			);
			const agent = writeAgent(value.directory, 'agent', 'process.exit(99);\n');

			const result = runCli({
				cwd: value.directory,
				args: ['--github-milestone', 'https://github.com/doberkofler/agent-task-queue/milestone/123', '--no-verify'],
				env: {GH_BIN: github, OPENCODE_BIN: agent, QUEUE_LOG_DIR: value.logDirectory},
			});

			expect(result.status).toBe(0);
			const calls = readFileSync(callsPath, 'utf8');
			expect(calls.indexOf(ISSUE_URL)).toBeLessThan(calls.indexOf(issue17));
			expect(calls).not.toContain(pullRequest);
		});

		it('processes an open issue and records the closure footer', () => {
			const value = githubFixture();
			const github = writeGithubCli(value.directory, 'OPEN', ISSUE_URL);
			const agent = writeAgent(value.directory, 'agent', RECORDING_AGENT);

			const result = runQueue(value, agent, {env: {GH_BIN: github}});

			expect(result.status).toBe(0);
			const prompt = readFileSync(path.join(value.directory, 'prompt.txt'), 'utf8');
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
				args: ['--no-verify', '--queue-stdin'],
				env: {GH_BIN: github, OPENCODE_BIN: agent, QUEUE_LOG_DIR: value.logDirectory},
				input: JSON.stringify({version: 1, kind: 'github-issues', items: [{url: ISSUE_URL}]}),
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain('no pending tasks');
			expect(() => readFileSync(path.join(value.directory, 'argv.json'), 'utf8')).toThrow('ENOENT');
		});

		it('skips issues with local completion commits without GitHub access', () => {
			const value = githubFixture();
			const agent = writeAgent(value.directory, 'agent', 'process.exit(99);\n');
			git(value.directory, 'commit', '--allow-empty', '-m', 'chore: mark done: #16', '-m', 'Closes doberkofler/agent-task-queue#16');

			const result = runQueue(value, agent, {env: {GH_BIN: '/nonexistent/gh'}});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain('no pending tasks');
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
				args: ['--config', configPath, '--no-verify', '--queue-file', value.queuePath],
				env: {OPENCODE_BIN: agent, QUEUE_LOG_DIR: value.logDirectory},
			});

			expect(result.status).toBe(1);
			expect(result.stderr).toContain('GitHub issue queues require completion.commit true');
		});
	});
});
