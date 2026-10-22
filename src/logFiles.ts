import {chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

import {type RunLogs} from './types.ts';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const pad = (value: number): string => String(value).padStart(2, '0');

const timestamp = (): string => {
	const now = new Date();
	return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

/** Replaces a file atomically while preserving its permissions. */
export const atomicWrite = (pathName: string, content: string): void => {
	const {mode} = statSync(pathName);
	const temporary = path.join(path.dirname(pathName), `.${path.basename(pathName)}.${String(process.pid)}.${String(Date.now())}.tmp`);
	try {
		writeFileSync(temporary, content, {encoding: 'utf8', mode});
		chmodSync(temporary, mode);
		try {
			renameSync(temporary, pathName);
		} catch {
			// Windows cannot replace an existing file with rename.
			unlinkSync(pathName);
			renameSync(temporary, pathName);
		}
	} finally {
		if (existsSync(temporary)) {
			unlinkSync(temporary);
		}
	}
};

/** Allocates unused agent and history log paths for one queue item. */
export const allocateLogPaths = (directory: string, issue: number | string): RunLogs => {
	mkdirSync(directory, {recursive: true, mode: PRIVATE_DIRECTORY_MODE});
	const stamp = timestamp();
	let stem = `${stamp}-${String(issue)}`;
	let agent = path.join(directory, `${stem}.jsonl`);
	let history = path.join(directory, `${stem}.log`);
	let sequence = 1;
	while (existsSync(agent) || existsSync(history)) {
		stem = `${stamp}-${String(issue)}-${String(sequence)}`;
		agent = path.join(directory, `${stem}.jsonl`);
		history = path.join(directory, `${stem}.log`);
		sequence += 1;
	}
	return {agent, history};
};

/** Creates a new private log file and returns its descriptor. */
export const openPrivate = (pathName: string): number => openSync(pathName, 'wx', PRIVATE_FILE_MODE);

/** Opens an existing log for appending and returns its descriptor. */
export const openAppend = (pathName: string): number => openSync(pathName, 'a');

/** Writes one chunk to an open descriptor. */
export const writeTo = (descriptor: number, text: string): void => {
	writeSync(descriptor, text);
};

/** Closes a descriptor without masking an earlier failure. */
export const closeQuietly = (descriptor: number): void => {
	try {
		closeSync(descriptor);
	} catch {
		// The descriptor is already closed or never opened; nothing to recover.
	}
};

/** Replaces the home directory prefix with `~` for terminal display. */
export const displayPath = (pathName: string): string => {
	const home = homedir();
	return pathName.startsWith(`${home}/`) ? `~/${pathName.slice(home.length + 1)}` : pathName;
};
