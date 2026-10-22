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

/** One OpenCode invocation: flags on the command line and the prompt on stdin. */
export type OpenCodeInvocation = {
	readonly command: readonly string[];
	readonly prompt: string;
};

/** Builds the OpenCode invocation for one queue item. */
export const openCodeInvocation = (options: OpenCodeCommandOptions): OpenCodeInvocation => {
	const command = [environment.OPENCODE_BIN ?? 'opencode', 'run', '--standalone', '--auto', '--agent', options.agentName, '--format', 'json'];
	if (options.model !== null) {
		command.push('--model', options.model);
	}
	return {command, prompt: promptFor(options.item, options.queuePath, options.commitPolicy)};
};
