import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
		reporters: ['default'],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		coverage: {
			// CLI integration tests execute the runner in child processes, so v8
			// coverage cannot observe most of the production code. Run coverage
			// explicitly when investigating unit-level gaps.
			enabled: false,
			provider: 'v8',
			include: ['src/**/*.ts'],
			reporter: ['text'],
			thresholds: {
				statements: 85,
				lines: 85,
				functions: 85,
				branches: 75,
			},
		},
	},
});
