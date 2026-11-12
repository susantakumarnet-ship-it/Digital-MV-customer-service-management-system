import mongoose, { type ClientSession } from 'mongoose';

/**
 * Run `fn` inside a MongoDB transaction (requires a replica set — D-27/D-28).
 * The driver retries on TransientTransactionError / UnknownTransactionCommitResult,
 * so `fn` must only perform database work (no emails or other side effects).
 * Side effects belong in `afterCommit` callbacks.
 */
export async function withTransaction<T>(
  fn: (session: ClientSession, afterCommit: (cb: () => unknown) => void) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  let result!: T;
  let callbacks: (() => unknown)[] = [];
  try {
    await session.withTransaction(async () => {
      callbacks = [];
      result = await fn(session, (cb) => callbacks.push(cb));
    });
  } finally {
    await session.endSession();
  }
  for (const cb of callbacks) {
    try {
      await cb();
    } catch {
      // after-commit side effects must never fail the committed request; they log internally.
    }
  }
  return result;
}
