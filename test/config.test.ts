import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {applyOverrides, loadConfiguration} from '../src/config.ts';
import {createTemporaryDirectory, removeTemporaryDirectory} from './helpers/workspace.ts';

describe('config', () => {
	const temporaryDirectories: string[] = [];

	const writeConfiguration = (content: string): string => {
		const directory = createTemporaryDirectory();
		temporaryDirectories.push(directory);
		const configPath = path.join(directory, 'agent-task-queue.config.json');
		writeFileSync(configPath, content, 'utf8');
		return configPath;
	};

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			removeTemporaryDirectory(directory);
		}
	});

	describe('loadConfiguration', () => {
		it('uses generic defaults when no file exists', () => {
			const configuration = loadConfiguration(null);
			expect(configuration.agent).toStrictEqual({backend: 'opencode', name: 'build', model: null, timeoutSeconds: 3600});
			expect(configuration.repository).toStrictEqual({requireCleanTree: true, commitPolicy: 'exactly-one', requireChangedFiles: true});
			expect(configuration.verification).toStrictEqual({command: null, timeoutSeconds: 900, preflight: true, afterEachTask: true});
			expect(configuration.completion).toStrictEqual({commit: true, closeGitHubIssue: true});
		});

		it('parses policy and command overrides', () => {
			const configPath = writeConfiguration(
				JSON.stringify({
					repository: {commitPolicy: 'none', requireCleanTree: false},
					verification: {command: ['pnpm', 'verify'], afterEachTask: false},
					completion: {commit: false},
				}),
			);
			const configuration = loadConfiguration(configPath);
			expect(configuration.repository.commitPolicy).toBe('none');
			expect(configuration.repository.requireCleanTree).toBe(false);
			expect(configuration.verification.command).toStrictEqual(['pnpm', 'verify']);
			expect(configuration.completion.commit).toBe(false);
		});

		it('rejects unknown keys', () => {
			const configPath = writeConfiguration('{"agent":{"model":"x"},"unknown":true}');
			expect(() => loadConfiguration(configPath)).toThrow('Invalid configuration');
		});

		it('rejects a no-commit policy that still commits completion', () => {
			const configPath = writeConfiguration('{"repository":{"commitPolicy":"none"}}');
			expect(() => loadConfiguration(configPath)).toThrow('requires completion.commit false');
		});

		it('rejects uncommitted completion with a clean-tree requirement', () => {
			const configPath = writeConfiguration('{"completion":{"commit":false}}');
			expect(() => loadConfiguration(configPath)).toThrow('requires repository.requireCleanTree false');
		});

		it('reports a missing explicit file', () => {
			expect(() => loadConfiguration('/does-not-exist/config.json')).toThrow('Configuration file not found');
		});
	});

	describe('applyOverrides', () => {
		it('applies terminal values on top of the configuration', () => {
			const configuration = applyOverrides(loadConfiguration(null), {
				model: 'openai/gpt',
				agentTimeoutSeconds: 10,
				verificationCommand: 'pnpm verify',
				verificationTimeoutSeconds: 5,
			});
			expect(configuration.agent.model).toBe('openai/gpt');
			expect(configuration.agent.timeoutSeconds).toBe(10);
			expect(configuration.verification.command).toBe('pnpm verify');
			expect(configuration.verification.timeoutSeconds).toBe(5);
		});
	});
});
