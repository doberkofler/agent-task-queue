import {type KnipConfig} from 'knip';

const config: KnipConfig = {
	treatConfigHintsAsErrors: true,
	workspaces: {
		'.': {
			entry: ['test/**/*.test.ts'],
			project: ['src/**/*.ts', 'test/**/*.ts'],
		},
	},
};

export default config;
