const TERMINAL_WIDTH_FALLBACK = 120;
const MIN_TERMINAL_WIDTH = 60;
const MAX_TERMINAL_WIDTH = 160;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
const ANSI_ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;

/** Removes terminal control sequences and non-printable control characters. */
export const sanitize = (value: string): string => value.replaceAll(ANSI_ESCAPE_SEQUENCE, '').replaceAll(CONTROL_CHARACTERS, '');

/** Returns the usable terminal width, bounded for readability. */
export const terminalWidth = (): number => {
	const columns: unknown = Reflect.get(process.stdout, 'columns');
	if (typeof columns !== 'number' || !Number.isFinite(columns)) {
		return TERMINAL_WIDTH_FALLBACK;
	}
	return Math.max(MIN_TERMINAL_WIDTH, Math.min(MAX_TERMINAL_WIDTH, columns));
};

/** Clips text to a single line of at most `width` characters. */
export const clip = (value: string, width: number): string => (value.length <= width ? value : `${value.slice(0, width - 1)}…`);

/** Collapses whitespace, strips control sequences, and clips to one line. */
export const shorten = (value: string, width = terminalWidth()): string => clip(sanitize(value).trim().replaceAll(/\s+/gu, ' '), width);

/** Formats elapsed seconds as seconds below one minute and as minutes otherwise. */
export const formatDuration = (seconds: number): string => {
	const whole = Math.trunc(seconds);
	return whole < 60 ? `${seconds.toFixed(1)}s` : `${Math.trunc(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
};
