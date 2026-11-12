import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../common/logger';

// Unknown filter keys are dropped, not passed to MongoDB. Operator-injection is handled by the
// request sanitiser (common/middleware/security.ts) plus Zod validation of every input.
mongoose.set('strictQuery', true);

export async function connectDatabase(uri = env().MONGODB_URI, dbName = env().MONGODB_DB) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(uri, {
    dbName,
    autoIndex: env().NODE_ENV !== 'production',
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: 20,
  });
  logger.info({ db: dbName }, 'MongoDB connected');
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

/** Readiness check used by /health/ready. Also reports whether transactions are available. */
export async function databaseStatus() {
  const conn = mongoose.connection;
  if (conn.readyState !== 1 || !conn.db) return { ok: false, replicaSet: false };
  await conn.db.admin().ping();
  const hello = (await conn.db.admin().command({ hello: 1 })) as { setName?: string; msg?: string };
  return { ok: true, replicaSet: Boolean(hello.setName) || hello.msg === 'isdbgrid' };
}
