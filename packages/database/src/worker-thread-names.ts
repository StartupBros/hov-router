/**
 * Thread names for the database's worker threads, passed as the Worker `name`
 * option. Bun sets each as the OS thread name, so on Linux
 * /proc/<pid>/task/<tid>/comm and `top -H` say which lane a thread serves;
 * unnamed, every worker thread reads "Worker".
 *
 * Linux keeps the first 15 bytes of a thread name and silently drops the
 * rest, so each name stays within 15 bytes and differs from the others.
 * A name only labels a thread: proving which lane serves an endpoint still
 * takes a per-thread syscr burst
 * (docs/solutions/workflow-issues/verify-worker-thread-lanes-by-per-thread-syscr.md).
 */
export const DB_WORKER_THREAD_NAMES = {
	bulkReader: "db-read-bulk",
	interactiveReader: "db-read-inter",
	writer: "db-writer",
	incrementalVacuum: "db-incvac",
	compaction: "db-compact",
	integrityCheck: "db-integrity",
} as const;
