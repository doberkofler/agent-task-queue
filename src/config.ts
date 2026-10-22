import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';

import {QueueError} from './errors.ts';
import {parseJsonContent} from './queue/json.ts';
import {type CommitPolicy} from './types.ts';

const CONFIG_FILE_NAME = 'agent-task-queue.config.json';
const DEFAULT_AGENT_TIMEOUT_SECONDS = 3600;
const DEFAULT_VERIFY_TIMEOUT_SECONDS = 900;

const AgentSchema = z.strictObject({
	backend: z.literal('opencode').default('opencode'),
	name: z.string().trim().min(1).default('build'),
	model: z.string().trim().min(1).nullable().default(null),
	timeoutSeconds: z.number().positive().default(DEFAULT_AGENT_TIMEOUT_SECONDS),
});

const RepositorySchema = z.strictObject({
	requireCleanTree: z.boolean().default(true),
	commitPolicy: z.enum(['exactly-one', 'at-least-one', 'none']).default('exactly-one'),
	requireChangedFiles: z.boolean().default(true),
});

const VerificationSchema = z.strictObject({
	command: z
		.union([z.string().trim().min(1), z.array(z.string().min(1)).min(1)])
		.nullable()
		.default(null),
	timeoutSeconds: z.number().positive().default(DEFAULT_VERIFY_TIMEOUT_SECONDS),
	preflight: z.boolean().default(true),
	afterEachTask: z.boolean().default(true),
});

const CompletionSchema = z.strictObject({
	commit: z.boolean().default(true),
	closeGitHubIssue: z.boolean().default(true),
});

const ConfigurationSchema = z.strictObject({
	agent: AgentSchema.default(AgentSchema.parse({})),
	repository: RepositorySchema.default(RepositorySchema.parse({})),
	verification: VerificationSchema.default(VerificationSchema.parse({})),
	completion: CompletionSchema.default(CompletionSchema.parse({})),
});

/** Fully resolved runner configuration. */
export type Configuration = {
	readonly agent: {
		readonly backend: 'opencode';
		readonly name: string;
		readonly model: string | null;
		readonly timeoutSeconds: number;
	};
	readonly repository: {
		readonly requireCleanTree: boolean;
		readonly commitPolicy: CommitPolicy;
		readonly requireChangedFiles: boolean;
	};
	readonly verification: {
		readonly command: string | readonly string[] | null;
		readonly timeoutSeconds: number;
		readonly preflight: boolean;
		readonly afterEachTask: boolean;
	};
	readonly completion: {
		readonly commit: boolean;
		readonly closeGitHubIssue: boolean;
	};
};

const validate = (configuration: Configuration): Configuration => {
	if (configuration.repository.commitPolicy === 'none' && configuration.completion.commit) {
		throw new QueueError('repository.commitPolicy "none" requires completion.commit false');
	}
	if (!configuration.completion.commit && configuration.repository.requireCleanTree) {
		throw new QueueError('completion.commit false requires repository.requireCleanTree false');
	}
	return configuration;
};

/** Loads and validates the configuration file; a missing default file means defaults. */
export const loadConfiguration = (configPath: string | null): Configuration => {
	const resolved = configPath ?? path.join(process.cwd(), CONFIG_FILE_NAME);
	if (configPath === null && !existsSync(resolved)) {
		return validate(ConfigurationSchema.parse({}));
	}
	if (!existsSync(resolved)) {
		throw new QueueError(`Configuration file not found: ${resolved}`);
	}
	const parsed = ConfigurationSchema.safeParse(parseJsonContent(readFileSync(resolved, 'utf8')));
	if (!parsed.success) {
		throw new QueueError(`Invalid configuration ${resolved}:\n${z.prettifyError(parsed.error)}`, {cause: parsed.error});
	}
	return validate(parsed.data);
};

/** Terminal overrides that take precedence over the configuration file. */
export type ConfigurationOverrides = {
	readonly model?: string;
	readonly agentTimeoutSeconds?: number;
	readonly verificationCommand?: string;
	readonly verificationTimeoutSeconds?: number;
};

/** Applies explicit command-line values on top of the configuration file. */
export const applyOverrides = (configuration: Configuration, overrides: ConfigurationOverrides): Configuration =>
	validate({
		...configuration,
		agent: {
			...configuration.agent,
			...(overrides.model === undefined ? {} : {model: overrides.model}),
			...(overrides.agentTimeoutSeconds === undefined ? {} : {timeoutSeconds: overrides.agentTimeoutSeconds}),
		},
		verification: {
			...configuration.verification,
			...(overrides.verificationCommand === undefined ? {} : {command: overrides.verificationCommand}),
			...(overrides.verificationTimeoutSeconds === undefined ? {} : {timeoutSeconds: overrides.verificationTimeoutSeconds}),
		},
	});
