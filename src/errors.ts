/** Errors that describe a violated runner or queue contract. */
export class QueueError extends Error {
	public override readonly name: string = 'QueueError';
}

/** Invalid command-line usage; reported with exit code 2. */
export class UsageError extends QueueError {
	public override readonly name: string = 'UsageError';
}

/** Raised when the runner is asked to stop by an operating-system signal. */
export class TerminationRequestedError extends Error {
	public override readonly name: string = 'TerminationRequestedError';
}
