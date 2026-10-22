import {z} from 'zod';

const EnvironmentSchema = z.object({
	OPENCODE_BIN: z.string().min(1).optional(),
	GH_BIN: z.string().min(1).optional(),
	QUEUE_MODEL: z.string().min(1).optional(),
	QUEUE_LOG_DIR: z.string().min(1).optional(),
	XDG_STATE_HOME: z.string().min(1).optional(),
	NO_COLOR: z.string().optional(),
	FORCE_COLOR: z.string().optional(),
	HOME: z.string().min(1).optional(),
	PATH: z.string().default(''),
});

/** Validated environment for this executable; the only reader of process.env. */
export const environment = EnvironmentSchema.parse(process.env);
