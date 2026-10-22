import {environment} from '../environment.ts';
import {promptFor} from '../prompt.ts';
import {type CommitPolicy, type QueueItem} from '../types.ts';

/** Inputs for one OpenCode invocation. */
export type OpenCodeCommandOptions = {
	readonly item: QueueItem;
	readonly queuePath: string | null;
	readonly model: string | null;
	readonly agentName: string;
	readonly commitPolicy: CommitPolicy;
};

/** Builds the OpenCode invocation for one queue item. */
export const openCodeCommand = (options: OpenCodeCommandOptions): readonly string[] => {
	const command = [environment.OPENCODE_BIN ?? 'opencode', 'run', '--standalone', '--auto', '--agent', options.agentName, '--format', 'json'];
	if (options.model !== null) {
		command.push('--model', options.model);
	}
	command.push(promptFor(options.item, options.queuePath, options.commitPolicy));
	return command;
};
