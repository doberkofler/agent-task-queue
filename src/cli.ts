#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {type ChildProcess} from 'node:child_process';
import {z} from 'zod';

import {applyOverrides, loadConfiguration, type Configuration} from './config.ts';
import {environment} from './environment.ts';
import {TerminationRequestedError, UsageError} from './errors.ts';
import {startSleepInhibitor, stopSleepInhibitor} from './platform/sleepInhibitor.ts';
import {parseJsonContent} from './queue/json.ts';
import {processQueue} from './runner/processQueue.ts';

const DEFAULT_QUEUE = 'TODO.md';

const HELP = `Usage: agent-task-queue [options] [queue]

Runs queued agent tasks sequentially in isolated OpenCode sessions.

Arguments:
  queue                     Markdown or JSON queue file; "-" reads a GitHub JSON queue from stdin
                            (default: ${DEFAULT_QUEUE})

Options:
  --model <name>            provider/model[#variant]; defaults to QUEUE_MODEL, then OpenCode
  --verbose                 show agent diagnostics and unrecognized events
  --verify <command>        trusted shell command run before agents and after each agent commit
  --no-verify               explicitly skip independent verification
  --timeout <seconds>       agent wall-clock timeout (default: 3600)
  --verify-timeout <seconds> verification wall-clock timeout (default: 900)
  --config <path>           configuration file (default: agent-task-queue.config.json)
  -h, --help                show this help
  -v, --version             show the version
`;

/** Result of terminal argument parsing. */
type TerminalArguments = {
	readonly queue: string;
	readonly model?: string;
	readonly verbose: boolean;
	readonly verify?: string;
	readonly noVerify: boolean;
	readonly timeoutSeconds?: number;
	readonly verifyTimeoutSeconds?: number;
	readonly configPath?: string;
	readonly help: boolean;
	readonly version: boolean;
};

const positiveSeconds = (value: string, option: string): number => {
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new UsageError(`${option} must be a number of seconds greater than zero`);
	}
	return seconds;
};

const positionalQueue = (positionals: readonly string[]): string => {
	if (positionals.length > 1) {
		throw new UsageError('Expected at most one queue path');
	}
	return positionals[0] ?? DEFAULT_QUEUE;
};

const parseTerminalArguments = (terminal: readonly string[]): TerminalArguments => {
	const parsed = parseArgs({
		args: [...terminal],
		allowPositionals: true,
		strict: true,
		options: {
			model: {type: 'string'},
			verbose: {type: 'boolean'},
			verify: {type: 'string'},
			'no-verify': {type: 'boolean'},
			timeout: {type: 'string'},
			'verify-timeout': {type: 'string'},
			config: {type: 'string'},
			help: {type: 'boolean', short: 'h'},
			version: {type: 'boolean', short: 'v'},
		},
	});
	const {model} = parsed.values;
	const {verify} = parsed.values;
	const {timeout} = parsed.values;
	const verifyTimeout = parsed.values['verify-timeout'];
	const configPath = parsed.values.config;
	return {
		queue: positionalQueue(parsed.positionals),
		...(model === undefined ? {} : {model}),
		verbose: parsed.values.verbose === true,
		...(verify === undefined ? {} : {verify}),
		noVerify: parsed.values['no-verify'] === true,
		...(timeout === undefined ? {} : {timeoutSeconds: positiveSeconds(timeout, '--timeout')}),
		...(verifyTimeout === undefined ? {} : {verifyTimeoutSeconds: positiveSeconds(verifyTimeout, '--verify-timeout')}),
		...(configPath === undefined ? {} : {configPath}),
		help: parsed.values.help === true,
		version: parsed.values.version === true,
	};
};

const VersionSchema = z.object({version: z.string().min(1)});

const version = (): string => {
	const manifest = VersionSchema.parse(parseJsonContent(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
	return manifest.version;
};

const resolveConfiguration = (terminal: TerminalArguments): Configuration => {
	const configuration = loadConfiguration(terminal.configPath ?? null);
	const model = terminal.model ?? environment.QUEUE_MODEL;
	const withOverrides = applyOverrides(configuration, {
		...(model === undefined ? {} : {model}),
		...(terminal.timeoutSeconds === undefined ? {} : {agentTimeoutSeconds: terminal.timeoutSeconds}),
		...(terminal.verify === undefined ? {} : {verificationCommand: terminal.verify}),
		...(terminal.verifyTimeoutSeconds === undefined ? {} : {verificationTimeoutSeconds: terminal.verifyTimeoutSeconds}),
	});
	if (!terminal.noVerify) {
		return withOverrides;
	}
	return applyOverrides({...withOverrides, verification: {...withOverrides.verification, command: null}}, {});
};

const verifyPolicy = (terminal: TerminalArguments, configuration: Configuration): void => {
	if (terminal.verify !== undefined && terminal.noVerify) {
		throw new UsageError('--verify and --no-verify are mutually exclusive');
	}
	if (terminal.verify?.trim() === '') {
		throw new UsageError('--verify command must not be empty');
	}
	if (configuration.verification.command === null && !terminal.noVerify) {
		throw new UsageError('--verify or --no-verify is required when verification.command is not configured');
	}
};

const run = async (terminal: TerminalArguments): Promise<number> => {
	const configuration = resolveConfiguration(terminal);
	verifyPolicy(terminal, configuration);
	const controller = new AbortController();
	let receivedSignal: NodeJS.Signals | null = null;
	const onSignal = (signal: NodeJS.Signals): void => {
		receivedSignal ??= signal;
		controller.abort();
	};
	const onInterrupt = (): void => {
		onSignal('SIGINT');
	};
	const onTerminate = (): void => {
		onSignal('SIGTERM');
	};
	process.on('SIGINT', onInterrupt);
	process.on('SIGTERM', onTerminate);
	let inhibitor: ChildProcess | null = null;

	try {
		inhibitor = startSleepInhibitor();
		const queuePath = terminal.queue === '-' ? null : terminal.queue;
		const queueContent = queuePath === null ? readFileSync(0, 'utf8') : null;
		await processQueue({queuePath, queueContent, configuration, verbose: terminal.verbose, signal: controller.signal});
		return 0;
	} catch (error) {
		if (error instanceof TerminationRequestedError) {
			const terminated = String(receivedSignal) === 'SIGTERM';
			process.stderr.write(`agent-task-queue: ${terminated ? 'terminated' : 'interrupted'}\n`);
			return terminated ? 143 : 130;
		}
		if (error instanceof UsageError) {
			process.stderr.write(`agent-task-queue: ${error.message}\n`);
			return 2;
		}
		process.stderr.write(`agent-task-queue: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		process.off('SIGINT', onInterrupt);
		process.off('SIGTERM', onTerminate);
		await stopSleepInhibitor(inhibitor);
	}
};

const main = async (): Promise<number> => {
	let terminal: TerminalArguments;
	try {
		terminal = parseTerminalArguments(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`agent-task-queue: ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
	if (terminal.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (terminal.version) {
		process.stdout.write(`agent-task-queue ${version()}\n`);
		return 0;
	}
	try {
		return await run(terminal);
	} catch (error) {
		process.stderr.write(`agent-task-queue: ${error instanceof Error ? error.message : String(error)}\n`);
		return error instanceof UsageError ? 2 : 1;
	}
};

process.exitCode = await main();
