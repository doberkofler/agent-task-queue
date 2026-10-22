import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync, type SpawnSyncReturns} from 'node:child_process';

/** Absolute path of the project under test. */
const projectRoot = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(projectRoot, 'src', 'cli.ts');

/** Absolute path of the CLI entry point. */
export const cliExecutable = cliPath;

/** Creates a temporary directory removed by the caller. */
export const createTemporaryDirectory = (prefix = 'agent-task-queue-'): string => mkdtempSync(path.join(tmpdir(), prefix));

/** Removes a temporary directory and its contents. */
export const removeTemporaryDirectory = (directory: string): void => {
	rmSync(directory, {recursive: true, force: true});
};

/** Runs git in a working directory and returns its result. */
export const git = (cwd: string, ...args: readonly string[]): SpawnSyncReturns<string> => spawnSync('git', args, {cwd, encoding: 'utf8'});

/** Initializes a repository with deterministic commit identity. */
export const initializeRepository = (cwd: string): void => {
	git(cwd, 'init', '--quiet');
	git(cwd, 'config', 'user.email', 'test@example.com');
	git(cwd, 'config', 'user.name', 'Queue Test');
};

/** Adds every file and creates one commit. */
export const commitAll = (cwd: string, message: string): void => {
	git(cwd, 'add', '.');
	git(cwd, 'commit', '--quiet', '-m', message);
};

const executableSource = (name: string, scriptPath: string): {name: string; content: string} =>
	process.platform === 'win32'
		? {name: `${name}.cmd`, content: `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`}
		: {name, content: `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`};

/** Writes a Node script and returns a cross-platform executable wrapper. */
export const writeExecutable = (directory: string, name: string, source: string): string => {
	const scriptPath = path.join(directory, `${name}-script.mjs`);
	writeFileSync(scriptPath, source, 'utf8');
	const wrapper = executableSource(name, scriptPath);
	const wrapperPath = path.join(directory, wrapper.name);
	writeFileSync(wrapperPath, wrapper.content, 'utf8');
	if (process.platform !== 'win32') {
		chmodSync(wrapperPath, 0o755);
	}
	return wrapperPath;
};

/** Environment keys that each test controls explicitly. */
const CONTROLLED_ENVIRONMENT: ReadonlySet<string> = new Set(['OPENCODE_BIN', 'GH_BIN', 'QUEUE_MODEL', 'QUEUE_LOG_DIR', 'XDG_STATE_HOME']);

/** Builds a clean process environment with explicit overrides. */
export const cliEnvironment = (overrides: Readonly<Record<string, string>> = {}): Record<string, string | undefined> =>
	Object.fromEntries([...Object.entries(process.env).filter(([key]) => !CONTROLLED_ENVIRONMENT.has(key)), ...Object.entries(overrides)]);

/** Options for spawning the CLI under test. */
export type RunCliOptions = {
	readonly cwd: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly input?: string;
};

/** Result of one CLI invocation. */
export type RunCliResult = {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly signal: NodeJS.Signals | null;
};

/** Spawns the CLI from source and captures its output. */
export const runCli = (options: RunCliOptions): RunCliResult => {
	const result = spawnSync(process.execPath, [cliPath, ...options.args], {
		cwd: options.cwd,
		env: cliEnvironment(options.env),
		encoding: 'utf8',
		timeout: 120_000,
		maxBuffer: 16 * 1024 * 1024,
		...(options.input === undefined ? {} : {input: options.input}),
	});
	return {status: result.status, stdout: result.stdout, stderr: result.stderr, signal: result.signal};
};
