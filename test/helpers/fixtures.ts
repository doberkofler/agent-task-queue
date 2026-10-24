import {writeFileSync} from 'node:fs';
import path from 'node:path';

import {commitAll, createTemporaryDirectory, initializeRepository, runCli, type RunCliResult, writeExecutable} from './workspace.ts';

export const RECORDING_AGENT = `import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';

let prompt = '';
for await (const chunk of process.stdin) {
  prompt += chunk;
}
writeFileSync('prompt.txt', prompt);
writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
writeFileSync('implementation.txt', 'implemented');
spawnSync('git', ['add', 'argv.json', 'implementation.txt', 'prompt.txt'], {stdio: 'ignore'});
spawnSync('git', ['commit', '--quiet', '-m', 'feat: implement item'], {stdio: 'ignore'});
`;

export const NO_COMMIT_AGENT = 'process.exit(0);\n';

export const BACKGROUND_AGENT = `import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';

console.log(JSON.stringify({
  type: 'tool_use',
  part: {
    id: 'background-1',
    tool: 'shell',
    state: {status: 'running', input: {command: 'long-running-command', background: true}},
  },
}));
writeFileSync('implementation.txt', 'implemented');
spawnSync('git', ['add', 'implementation.txt'], {stdio: 'ignore'});
spawnSync('git', ['commit', '--quiet', '-m', 'feat: implement item'], {stdio: 'ignore'});
`;

export const SLEEP_AGENT = `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {stdio: 'ignore'});
writeFileSync('agent.pid', String(process.pid));
writeFileSync('child.pid', String(child.pid));
setTimeout(() => {}, 60000);
`;

export const SIGNAL_AGENT = `import {writeFileSync} from 'node:fs';

writeFileSync('agent.pid', String(process.pid));
setTimeout(() => {}, 60000);
`;

export const UNSTRUCTURED_AGENT = `import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';

console.log('unstructured diagnostic');
writeFileSync('implementation.txt', 'implemented');
spawnSync('git', ['add', 'implementation.txt'], {stdio: 'ignore'});
spawnSync('git', ['commit', '--quiet', '-m', 'feat: implement item'], {stdio: 'ignore'});
`;

export const eventAgent = (exitCode = 0): string => `import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';

const events = [
  {type: 'tool_use', part: {id: 'call_0', tool: 'shell', state: {status: 'completed', input: {command: 'pnpm test'}, title: 'shell'}}},
  {type: 'tool_use', part: {id: 'call_1', tool: 'read', state: {status: 'completed', input: {path: 'README.md'}, title: 'read'}}},
  {type: 'step_finish', part: {cost: 0.0012, tokens: {input: 100, output: 20, reasoning: 0}}},
  {type: 'text', part: {text: 'Implemented\\nthe runner.'}},
];
for (const event of events) {
  console.log(JSON.stringify(event));
}
console.error('agent diagnostic');
writeFileSync('implementation.txt', 'implemented');
spawnSync('git', ['add', 'implementation.txt'], {stdio: 'ignore'});
spawnSync('git', ['commit', '--quiet', '-m', 'feat: implement item'], {stdio: 'ignore'});
process.exit(${String(exitCode)});
`;

/** Temporary Git repository with a legacy JSON queue and a log directory. */
export type Fixture = {
	readonly directory: string;
	readonly logDirectory: string;
	readonly queuePath: string;
};

/** Creates the standard one-item JSON fixture. */
export const createFixture = (): Fixture => {
	const directory = createTemporaryDirectory();
	const logDirectory = createTemporaryDirectory();
	initializeRepository(directory);
	const queuePath = path.join(directory, 'queue.json');
	writeFileSync(queuePath, '{"items":[{"issue":14,"evaluation":"EVAL-006","title":"Runner","done":false}]}', 'utf8');
	return {directory, logDirectory, queuePath};
};

/** Writes an executable agent and commits the complete fixture. */
export const writeAgent = (directory: string, name: string, source: string): string => {
	const executable = writeExecutable(directory, name, source);
	commitAll(directory, 'test: initialize fixture');
	return executable;
};

/** Options for running the CLI against a fixture. */
export type RunQueueOptions = {
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly skipDefaultVerification?: boolean;
};

/** Runs the CLI with the fixture's queue and controlled agent/log environment. */
export const runQueue = (fixture: Fixture, agent: string, options: RunQueueOptions = {}): RunCliResult => {
	const args = options.args ?? [];
	const verification =
		options.skipDefaultVerification === true || args.some((argument) => argument === '--verify' || argument === '--no-verify') ? [] : ['--no-verify'];
	return runCli({
		cwd: fixture.directory,
		args: [...args, ...verification, '--queue-file', fixture.queuePath],
		env: {OPENCODE_BIN: agent, QUEUE_LOG_DIR: fixture.logDirectory, ...options.env},
	});
};

/** Writes a fake GitHub CLI that reports the given issue state. */
export const writeGithubCli = (directory: string, state: 'OPEN' | 'CLOSED', issueUrl: string): string =>
	writeExecutable(
		directory,
		'fake-gh',
		`console.log(JSON.stringify({
  number: 16,
  state: '${state}',
  title: '[EVAL-008] Normalize events',
  body: '## Acceptance criteria\\n\\n- [ ] Preserve raw events.',
  url: '${issueUrl}',
}));
`,
	);
