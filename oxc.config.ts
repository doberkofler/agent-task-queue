/**
 * Shared baseline for Oxlint and Oxfmt.
 *
 * Keep project-specific changes in `oxlint.config.ts` and `oxfmt.config.ts`.
 * This file mirrors the strict template configuration used by sibling projects.
 */

import {configs as regexpConfigs} from 'eslint-plugin-regexp';
import {defineConfig} from 'oxlint';

/** Filter out core ESLint rules bundled into eslint-plugin-regexp recommended config */
const regexpPluginRules = Object.fromEntries(Object.entries(regexpConfigs.recommended.rules).filter(([key]) => key.startsWith('regexp/')));

const commonIgnore = ['**/.*', 'node_modules/**', 'dist/**', 'build/**', 'coverage/**', 'temp/**', 'public/**', 'test/fixtures/**', '**/*.md'];

export const linter = defineConfig({
	options: {
		typeAware: true,
		typeCheck: true,
	},
	plugins: ['unicorn', 'typescript', 'oxc', 'import', 'jsdoc', 'promise', 'vitest'],
	jsPlugins: ['eslint-plugin-regexp'],
	categories: {
		correctness: 'error',
		nursery: 'error',
		pedantic: 'error',
		perf: 'error',
		restriction: 'error',
		style: 'error',
		suspicious: 'error',
	},
	rules: {
		...regexpPluginRules,
		'eslint/capitalized-comments': 'off',
		'eslint/complexity': ['error', 15],
		'eslint/curly': ['error', 'all'],
		'eslint/id-length': 'off',
		'eslint/init-declarations': 'off',
		'eslint/max-classes-per-file': ['error', 1],
		'eslint/max-depth': ['error', 4],
		'eslint/max-lines': ['error', 500],
		'eslint/max-lines-per-function': ['error', {max: 100, skipBlankLines: true, skipComments: true, IIFEs: true}],
		'eslint/max-nested-callbacks': ['error', 3],
		'eslint/max-params': ['error', 4],
		'eslint/max-statements': ['error', 40],
		'eslint/no-await-in-loop': 'error',
		'eslint/no-bitwise': ['error', {allow: ['&']}],
		'eslint/no-console': 'error',
		'eslint/no-continue': 'off',
		'eslint/no-inline-comments': 'off',
		'eslint/no-magic-numbers': 'off',
		'eslint/no-negated-condition': 'off',
		'eslint/no-nested-ternary': 'off',
		'eslint/no-warning-comments': 'off',
		'eslint/no-undefined': 'off',
		'eslint/no-plusplus': 'off',
		'eslint/one-var': 'off',
		'eslint/sort-imports': 'off',
		'eslint/sort-keys': 'off',
		'eslint/no-ternary': 'off',
		'eslint/no-void': ['error', {allowAsStatement: true}],
		'typescript/consistent-type-definitions': ['error', 'type'],
		'typescript/dot-notation': ['error', {allowIndexSignaturePropertyAccess: true, allowPattern: '^[a-zA-Z]+(_[a-zA-Z]+)+$'}],
		'typescript/no-import-type-side-effects': 'off',
		'typescript/no-unused-vars': [
			'error',
			{
				caughtErrors: 'none',
				argsIgnorePattern: '^_',
			},
		],
		'typescript/prefer-readonly-parameter-types': 'off',
		'import/consistent-type-specifier-style': ['error', 'prefer-inline'],
		'import/exports-last': 'off',
		'import/group-exports': 'off',
		'import/max-dependencies': 'off',
		'import/no-named-export': 'off',
		'import/no-namespace': 'off',
		'import/no-nodejs-modules': 'off',
		'import/no-relative-parent-imports': 'off',
		'import/no-unassigned-import': ['error', {allow: ['**/*.css']}],
		'import/prefer-default-export': 'off',
		'import/no-default-export': 'off',
		'jsdoc/require-param': 'error',
		'jsdoc/require-param-type': 'off',
		'jsdoc/require-returns': 'error',
		'jsdoc/require-returns-type': 'off',
		'oxc/no-async-await': 'off',
		'oxc/no-map-spread': 'off',
		'oxc/no-optional-chaining': 'off',
		'oxc/no-rest-spread-properties': 'off',
		'unicorn/escape-case': 'off',
		'unicorn/filename-case': 'off',
		'unicorn/max-nested-calls': ['error', {max: 5}],
		'unicorn/no-array-reduce': 'off',
		'unicorn/no-array-sort': 'off',
		'unicorn/no-hex-escape': 'off',
		'unicorn/no-immediate-mutation': 'off',
		'unicorn/no-negated-condition': 'off',
		'unicorn/no-nested-ternary': 'off',
		'unicorn/no-null': 'off',
		'unicorn/no-process-exit': 'off',
		'unicorn/no-typeof-undefined': 'off',
		'unicorn/prefer-module': 'off',
		'unicorn/prefer-number-coercion': 'off',
		'vitest/max-expects': 'off',
		'vitest/no-conditional-in-test': 'off',
		'vitest/no-hooks': 'off',
		'vitest/no-importing-vitest-globals': 'off',
		'vitest/prefer-describe-function-title': 'off',
		'vitest/prefer-expect-assertions': 'off',
		'vitest/prefer-lowercase-title': 'off',
		'vitest/prefer-to-be-falsy': 'off',
		'vitest/prefer-to-be-truthy': 'off',
		'vitest/require-hook': 'off',
		'vitest/require-test-timeout': 'off',
	},
	overrides: [
		{
			// Relax strict type rules for unit tests to allow easier mocking and test scaffolding.
			files: ['**/*.test.ts'],
			rules: {
				'typescript/no-unsafe-type-assertion': 'off',
				'typescript/no-explicit-any': 'off',
				'typescript/no-unsafe-assignment': 'off',
				'typescript/no-unsafe-member-access': 'off',
				'no-useless-undefined': 'off',
			},
		},
	],
	settings: {
		jsdoc: {
			ignorePrivate: false,
			ignoreInternal: false,
			ignoreReplacesDocs: true,
			overrideReplacesDocs: true,
			augmentsExtendsReplacesDocs: false,
			implementsReplacesDocs: false,
			exemptDestructuredRootsFromChecks: false,
			tagNamePreference: {},
		},
		vitest: {
			typecheck: false,
		},
	},
	env: {
		builtin: true,
		node: true,
	},
	globals: {},
	ignorePatterns: commonIgnore,
});

export const formatter = {
	printWidth: 160,
	embeddedLanguageFormatting: 'off',
	useTabs: true,
	singleQuote: true,
	bracketSpacing: false,
	ignorePatterns: commonIgnore,
};
