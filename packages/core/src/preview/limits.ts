// Every preview timeout and budget, in one place. Times are milliseconds, sizes bytes.

/** How long a dev server has to answer after it starts. First compiles of Next.js and Angular are slow. */
export const START_TIMEOUT = 120_000
export const INSTALL_TIMEOUT = 600_000
export const PROBE_INTERVAL = 500
export const PROBE_TIMEOUT = 2_000
/** How long a stopping dev server gets after SIGTERM before SIGKILL. */
export const STOP_GRACE = 5_000
/** A preview nobody has watched for this long stops. */
export const IDLE_STOP = 15 * 60_000
/** A second crash this soon after an automatic restart is reported instead of restarted again. */
export const CRASH_WINDOW = 60_000
export const LOG_BUFFER = 256 * 1024
export const AI_TRIES = 3
export const AI_BUDGET = 4 * 60_000
export const AI_STEPS = 12
export const AI_LOG_TAIL = 4 * 1024
