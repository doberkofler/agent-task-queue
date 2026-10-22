/** Reads one property from an unknown parsed JSON value without asserting a shape. */
export const readField = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

/** Returns a string property or an empty string. */
export const readString = (value: unknown, key: string): string => {
	const field = readField(value, key);
	return typeof field === 'string' ? field : '';
};

/** Returns a finite numeric property, or `undefined`. */
export const readNumber = (value: unknown, key: string): number | undefined => {
	const field = readField(value, key);
	return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
};
