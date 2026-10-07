/** Polls until `done(value)` is true. Eventual consistency without fixed sleeps. */
export async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms; last value: ${JSON.stringify(last)}`);
}
