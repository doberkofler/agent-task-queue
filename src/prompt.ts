import path from 'node:path';

import {type CommitPolicy, type QueueItem} from './types.ts';

const commitRule = (policy: CommitPolicy): string => {
	if (policy === 'exactly-one') {
		return '- Make exactly one commit (conventional commit message).\n';
	}
	if (policy === 'at-least-one') {
		return '- Make at least one commit (conventional commit messages).\n';
	}
	return '- Do not create commits; leave the validated changes in the working tree.\n';
};

/** Builds the isolated-session prompt for one queue item. */
export const promptFor = (item: QueueItem, queuePath: string | null, policy: CommitPolicy): string => {
	const source = item.sourceUrl !== undefined ? `\nGitHub issue: ${item.sourceUrl}\n\nIssue body:\n${item.details ?? ''}\n` : '';
	const queueRule = queuePath === null ? '- Queue source is read-only stdin.\n' : `- Do not modify the queue file: ${path.resolve(queuePath)}\n`;
	const completionRule = item.sourceUrl !== undefined ? '- Do not close the GitHub issue; the queue runner records completion after verification.\n' : '';
	return `Implement exactly this item, nothing else: ${item.description}${source}
Rules:
- Run tests/lint/typecheck; fix until green.
- Do not start background jobs; wait for every required command to finish.
${commitRule(policy)}${queueRule}${completionRule}- The queue runner marks the current item done after validating your commit.`;
};
