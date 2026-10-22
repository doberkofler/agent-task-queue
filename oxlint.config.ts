import {linter as defaults} from './oxc.config.ts';

// Project-specific Oxlint overrides.
const rules: Partial<typeof defaults.rules> = {};
type OverrideType = Readonly<{files: readonly string[]; rules: Readonly<Record<string, 'off' | 'warn' | 'error'>>}>;
const overrides: OverrideType[] = [
	{
		// The runner processes queue items strictly one after another: sequential
		// awaits are the product behavior, not an oversight.
		files: ['src/runner/**/*.ts', 'src/queue/githubQueue.ts'],
		rules: {
			'eslint/no-await-in-loop': 'off',
		},
	},
	{
		// The environment adapter is the single reader of process.env; every other
		// module imports the validated snapshot.
		files: ['src/environment.ts'],
		rules: {
			'node/no-process-env': 'off',
		},
	},
	{
		// Test files are containers for independent cases. File size stays bounded
		// by `eslint/max-lines`; the outer suite owns temporary-directory cleanup.
		files: ['test/**/*.test.ts'],
		rules: {
			'eslint/max-lines-per-function': 'off',
			'eslint/max-nested-callbacks': 'off',
			'eslint/no-await-in-loop': 'off',
		},
	},
	{
		// The CLI deliberately keeps one small error taxonomy together.
		files: ['src/errors.ts'],
		rules: {
			'eslint/max-classes-per-file': 'off',
		},
	},
	{
		// Sanitizing terminal output requires matching control characters and the
		// conventional ANSI escape ranges verbatim.
		files: ['src/sanitize.ts'],
		rules: {
			'eslint/no-control-regex': 'off',
			'regexp/no-obscure-range': 'off',
		},
	},
	{
		// Process supervision races a child exit, a wall-clock deadline, and an
		// abort signal. Those are promise combinators over native events, not a
		// callback API that can be replaced with `await`.
		files: ['src/platform/process.ts', 'src/platform/sleepInhibitor.ts'],
		rules: {
			'promise/avoid-new': 'off',
			'promise/prefer-await-to-callbacks': 'off',
		},
	},
	{
		// Process-tree termination polls the process group until the grace period
		// expires; sequential polling is the algorithm.
		files: ['src/platform/process.ts'],
		rules: {
			'eslint/no-await-in-loop': 'off',
		},
	},
	{
		// JSDoc describes exported behavior and non-obvious contracts. Per-parameter
		// tags would duplicate the explicit TypeScript signatures enforced here.
		files: ['src/**/*.ts', 'test/**/*.ts'],
		rules: {
			'jsdoc/require-param': 'off',
			'jsdoc/require-returns': 'off',
		},
	},
];

const config = {
	...defaults,
	rules: {...defaults.rules, ...rules},
	overrides: [...defaults.overrides, ...overrides],
	ignorePatterns: [...defaults.ignorePatterns],
};

export default config;
