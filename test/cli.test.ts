import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

import {createTemporaryDirectory, initializeRepository, removeTemporaryDirectory, runCli} from './helpers/workspace.ts';

const PackageManifestSchema = z.object({version: z.string().min(1)});

const packageVersion = (): string => {
	const manifestPath = path.resolve(import.meta.dirname, '../package.json');
	return PackageManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8'))).version;
};

describe('cli', () => {
	const temporaryDirectories: string[] = [];

	const repository = (): string => {
		const directory = createTemporaryDirectory();
		temporaryDirectories.push(directory);
		initializeRepository(directory);
		return directory;
	};

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			removeTemporaryDirectory(directory);
		}
	});

	describe('command line', () => {
		it('prints help', () => {
			const directory = repository();
			const result = runCli({cwd: directory, args: ['--help']});
			expect(result.status).toBe(0);
			expect(result.stdout).toContain('Usage: agent-task-queue');
			expect(result.stdout).toContain('--github-milestone');
		});

		it('prints the package version', () => {
			const directory = repository();
			const result = runCli({cwd: directory, args: ['--version']});
			expect(result.status).toBe(0);
			expect(result.stdout).toBe(`agent-task-queue ${packageVersion()}\n`);
		});

		it('rejects unknown options', () => {
			const directory = repository();
			const result = runCli({cwd: directory, args: ['--unknown']});
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('agent-task-queue');
		});

		it('requires an explicit queue source', () => {
			const directory = repository();
			const result = runCli({cwd: directory, args: ['--no-verify']});
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('Exactly one queue source is required');
		});

		it('rejects positional queue paths', () => {
			const directory = repository();
			const result = runCli({cwd: directory, args: ['TODO.md', '--no-verify']});
			expect(result.status).toBe(2);
		});

		it('rejects conflicting queue sources', () => {
			const directory = repository();
			const result = runCli({cwd: directory, args: ['--queue-file', 'TODO.md', '--github-issues', '1', '--no-verify']});
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('Exactly one queue source is allowed');
		});

		it('rejects the stdin path sentinel', () => {
			const directory = repository();
			const result = runCli({cwd: directory, args: ['--queue-file', '-', '--no-verify']});
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('--queue-stdin');
		});

		it('rejects non-positive timeouts', () => {
			const directory = repository();
			const result = runCli({cwd: directory, args: ['--timeout', '0', '--no-verify']});
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('greater than zero');
		});

		it('reports a missing explicit configuration file', () => {
			const directory = repository();
			const result = runCli({cwd: directory, args: ['--config', 'missing.json', '--no-verify', '--queue-file', 'TODO.md']});
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('Configuration file not found');
		});

		it('reports malformed queue configuration', () => {
			const directory = repository();
			const configPath = path.join(directory, 'agent-task-queue.config.json');
			writeFileSync(configPath, '{"verification":{"command":[]}}', 'utf8');
			const result = runCli({cwd: directory, args: ['--config', configPath, '--queue-file', 'TODO.md']});
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('Invalid configuration');
		});
	});
});
