import {homedir} from 'node:os';
import path from 'node:path';

import {readField, readString} from '../jsonValue.ts';
import {shorten} from '../sanitize.ts';

const MAX_PATH_LENGTH = 60;
const MAX_DETAIL_LENGTH = 50;

type Descriptor = (input: unknown, target: string) => string;

// Display paths always use forward slashes so terminal output is stable across platforms.
const displayPath = (value: string): string => value.split(path.sep).join('/');

const homeRelative = (value: string): string => {
	const home = homedir();
	if (value === home) {
		return '~';
	}
	return value.startsWith(`${home}${path.sep}`) ? `~/${displayPath(value.slice(home.length + 1))}` : displayPath(value);
};

/** Shortens an absolute path to a workspace-relative or home-relative form. */
export const workspacePath = (value: string): string => {
	if (value.length === 0) {
		return value;
	}
	const resolved = path.resolve(process.cwd(), value);
	const relative = path.relative(process.cwd(), resolved);
	const insideWorkspace = relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	return insideWorkspace ? displayPath(relative) : homeRelative(resolved);
};

const shortenPath = (value: string): string => (value.length <= MAX_PATH_LENGTH ? value : `…${value.slice(-(MAX_PATH_LENGTH - 1))}`);

const pathDetail = (input: unknown): string => {
	const value = readString(input, 'filePath') || readString(input, 'path');
	return value.length === 0 ? '' : shortenPath(workspacePath(value));
};

const hostOf = (url: string): string => {
	try {
		return new URL(url).hostname;
	} catch {
		return shorten(url, MAX_DETAIL_LENGTH);
	}
};

const inputOf = (part: unknown): unknown => readField(readField(part, 'state'), 'input');

const fileDescriptor =
	(verb: string, noun: string): Descriptor =>
	(_input, target) =>
		target.length === 0 ? `${verb} ${noun}` : `${verb} ${target}`;

const searchDescriptor: Descriptor = (input) => {
	const pattern = readString(input, 'pattern');
	return pattern.length === 0 ? 'Searching codebase' : `Searching for ${shorten(pattern, MAX_DETAIL_LENGTH)}`;
};

const fetchDescriptor: Descriptor = (input) => {
	const url = readString(input, 'url');
	return url.length === 0 ? 'Fetching web page' : `Fetching ${hostOf(url)}`;
};

const webSearchDescriptor: Descriptor = (input) => {
	const query = readString(input, 'query');
	return query.length === 0 ? 'Searching the web' : `Searching the web for ${shorten(query, MAX_DETAIL_LENGTH)}`;
};

const delegateDescriptor: Descriptor = (input) => {
	const description = readString(input, 'description');
	return description.length === 0 ? 'Delegating a task' : `Delegating ${shorten(description, MAX_DETAIL_LENGTH)}`;
};

const skillDescriptor: Descriptor = (input) => {
	const name = readString(input, 'name');
	return name.length === 0 ? 'Loading a skill' : `Loading skill ${name}`;
};

const commandDescriptor: Descriptor = (input) => {
	const command = readString(input, 'command');
	return command.trim().length === 0 ? 'Running command' : `Running ${shorten(command, MAX_DETAIL_LENGTH)}`;
};

const DESCRIPTORS: Readonly<Record<string, Descriptor>> = {
	read: fileDescriptor('Reading', 'files'),
	write: fileDescriptor('Writing', 'files'),
	edit: fileDescriptor('Editing', 'files'),
	glob: searchDescriptor,
	grep: searchDescriptor,
	list: fileDescriptor('Listing', 'files'),
	webfetch: fetchDescriptor,
	websearch: webSearchDescriptor,
	task: delegateDescriptor,
	subagent: delegateDescriptor,
	skill: skillDescriptor,
	bash: commandDescriptor,
	shell: commandDescriptor,
	execute: commandDescriptor,
};

/** Describes a tool call as one short, safe activity phrase. */
export const describeTool = (part: unknown): string => {
	const tool = readString(part, 'tool') || 'tool';
	const input = inputOf(part);
	const descriptor = DESCRIPTORS[tool];
	return descriptor === undefined ? `Using ${tool}` : descriptor(input, pathDetail(input));
};

/** Builds the detailed tool summary shown only in verbose mode. */
export const describeToolVerbose = (part: unknown): string => {
	const tool = readString(part, 'tool') || 'tool';
	const input = inputOf(part);
	for (const key of ['command', 'filePath', 'path', 'pattern', 'url', 'query']) {
		const value = readString(input, key);
		if (value.trim().length > 0) {
			return shorten(`${tool} ${value}`);
		}
	}
	return tool;
};
