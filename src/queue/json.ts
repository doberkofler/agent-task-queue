import {QueueError} from '../errors.ts';

/** Parses JSON text, converting syntax failures into runner contract errors. */
export const parseJsonContent = (content: string): unknown => {
	try {
		return JSON.parse(content);
	} catch (error) {
		throw new QueueError(`Invalid JSON queue: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
	}
};
