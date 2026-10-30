/**
 * Epoch milliseconds at which this process started: constant for the life of
 * the process and different after every restart, so per-request telemetry can
 * tell which process served a request. Read it on the main thread; inside a
 * worker, performance.timeOrigin is that worker's own start.
 */
export const PROCESS_STARTED_AT_MS = Math.floor(performance.timeOrigin);
