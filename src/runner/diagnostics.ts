import {clip, sanitize} from '../sanitize.ts';
import {type LineTail} from './lineTail.ts';

const MAX_PREVIEW_LINE_LENGTH = 400;

/** Writes the retained tail of a failed run to stderr. */
export const printFailureTail = (tail: LineTail): void => {
	if (tail.empty) {
		return;
	}
	process.stderr.write(`[failure] last ${String(tail.values().length)} log lines:\n`);
	for (const line of tail.values()) {
		process.stderr.write(`  ${clip(sanitize(line), MAX_PREVIEW_LINE_LENGTH)}\n`);
	}
};
