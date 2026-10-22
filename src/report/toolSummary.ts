import {readField, readString} from '../jsonValue.ts';
import {shorten} from '../sanitize.ts';

const TOOL_KEYS: Readonly<Record<string, readonly string[]>> = {
	bash: ['command'],
	shell: ['command'],
	read: ['filePath', 'path'],
	write: ['filePath', 'path'],
	edit: ['filePath', 'path'],
	glob: ['pattern'],
	grep: ['pattern'],
	list: ['path'],
	webfetch: ['url'],
	websearch: ['query'],
	task: ['description'],
	subagent: ['description'],
	skill: ['name'],
};

const detailFor = (name: string, input: unknown): string => {
	if (name === 'execute') {
		const code = readString(input, 'code');
		if (code.length > 0) {
			return (
				code
					.split('\n')
					.find((line) => line.trim().length > 0)
					?.trim() ?? ''
			);
		}
	}
	for (const key of TOOL_KEYS[name] ?? []) {
		const value = readString(input, key);
		if (value.trim().length > 0) {
			return value;
		}
	}
	return '';
};

/** Summarizes one streamed tool-use part for the terminal. */
export const summarizeTool = (part: unknown): string => {
	const toolName = readString(part, 'tool') || 'tool';
	const state = readField(part, 'state');
	const detail = detailFor(toolName, readField(state, 'input'));
	const title = readString(state, 'title');
	const fallback = title === toolName ? '' : title;
	return shorten(`${toolName} ${detail || fallback}`.trim());
};
