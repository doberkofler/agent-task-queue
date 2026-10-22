import crossSpawn from 'cross-spawn';

export {default as spawnProcess} from 'cross-spawn';

/** Cross-platform synchronous launcher that understands Windows `.cmd` shims. */
export const spawnProcessSync = crossSpawn.sync;
