import {environment} from '../environment.ts';
import {type TextWriter} from '../types.ts';

const ESCAPE = '\u001b[';

/** ANSI styles applied to terminal output. */
export type Palette = {
	readonly enabled: boolean;
	readonly bold: (text: string) => string;
	readonly dim: (text: string) => string;
	readonly red: (text: string) => string;
	readonly green: (text: string) => string;
	readonly yellow: (text: string) => string;
	readonly cyan: (text: string) => string;
};

/** Explicit color overrides; omitted values follow the environment and stream. */
export type PaletteOptions = {
	readonly noColor?: boolean;
	readonly forceColor?: boolean;
};

const paint = (enabled: boolean, open: number, close: number, text: string): string =>
	enabled ? `${ESCAPE}${String(open)}m${text}${ESCAPE}${String(close)}m` : text;

const environmentForceColor = (): boolean | undefined => {
	const {FORCE_COLOR: forceColor} = environment;
	if (forceColor === undefined || forceColor === '') {
		return undefined;
	}
	return forceColor !== '0';
};

/**
 * Creates the ANSI palette for one output stream.
 *
 * Color is disabled when `NO_COLOR` is present, when `FORCE_COLOR` is `0`, or
 * when the stream is not a terminal. `FORCE_COLOR` enables color on any stream.
 */
export const createPalette = (stream: TextWriter, options: PaletteOptions = {}): Palette => {
	const noColor = options.noColor ?? (environment.NO_COLOR !== undefined && environment.NO_COLOR !== '');
	const forceColor = options.forceColor ?? environmentForceColor();
	const enabled = noColor ? false : (forceColor ?? stream.isTTY === true);
	return {
		enabled,
		bold: (text) => paint(enabled, 1, 22, text),
		dim: (text) => paint(enabled, 2, 22, text),
		red: (text) => paint(enabled, 31, 39, text),
		green: (text) => paint(enabled, 32, 39, text),
		yellow: (text) => paint(enabled, 33, 39, text),
		cyan: (text) => paint(enabled, 36, 39, text),
	};
};

/** Applies Vitest-style colors to one plain progress line. */
export const paintEvent = (palette: Palette, line: string): string => {
	const symbol = line.slice(0, 1);
	const rest = line.slice(1);
	if (symbol === '✓') {
		return `${palette.green(symbol)}${rest}`;
	}
	if (symbol === '✗') {
		return palette.red(line);
	}
	if (symbol === '…') {
		return `${palette.cyan(symbol)}${rest}`;
	}
	if (symbol === '↓') {
		return `${palette.yellow(symbol)}${rest}`;
	}
	if (symbol === '●') {
		return `${palette.cyan(symbol)}${rest}`;
	}
	if (line.startsWith('error › ')) {
		return palette.red(line);
	}
	if (line.startsWith('log: ') || line.startsWith('event: ')) {
		return palette.dim(line);
	}
	const separator = line.indexOf(' › ');
	if (separator > 0) {
		return `${palette.dim(line.slice(0, separator))}${palette.dim(' › ')}${line.slice(separator + 3)}`;
	}
	return line;
};
