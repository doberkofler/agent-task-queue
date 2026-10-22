import {homedir} from 'node:os';
import path from 'node:path';

import {environment} from './environment.ts';

/** Resolves the directory that receives agent JSONL and complete history logs. */
export const logDirectory = (): string => {
	if (environment.QUEUE_LOG_DIR !== undefined) {
		return environment.QUEUE_LOG_DIR;
	}

	const stateHome = environment.XDG_STATE_HOME;
	return stateHome !== undefined ? path.join(stateHome, 'agent-task-queue') : path.join(homedir(), '.local', 'state', 'agent-task-queue');
};
