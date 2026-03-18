/**
 * Shared helpers for CLI scripts (batch concurrency, sleep).
 */

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run async tasks in chunks of `concurrency`; optional `delayMs` between chunks.
 * @param {Array<() => Promise<void>>} tasks
 * @param {number} concurrency
 * @param {number} delayMs
 */
export async function runBatches(tasks, concurrency, delayMs = 0) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    results.push(...(await Promise.allSettled(batch.map((fn) => fn()))));
    if (i + concurrency < tasks.length && delayMs > 0) await sleep(delayMs);
  }
  return results;
}
