import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll } from 'vitest';

/**
 * Integration tests run against a real MongoDB replica set (transactions), never against the
 * application database: each test file gets its own throwaway database which is dropped afterwards.
 * Override with MONGODB_URI_TEST (CI uses a service container).
 */
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI_TEST ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
process.env.MONGODB_DB = `mv_test_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64url');
process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.MAIL_TRANSPORT = 'none';
process.env.LOG_LEVEL = 'silent';
process.env.PUBLIC_APP_URL = 'http://localhost:5173';
process.env.WEB_ORIGINS = 'http://localhost:5173';

beforeAll(async () => {
  const { connectDatabase } = await import('../src/db/connection');
  await connectDatabase();
  // Create indexes up-front so unique constraints are enforced from the first test.
  const { ALL_MODELS } = await import('../src/db/models');
  await Promise.all(ALL_MODELS.map((m) => m.createCollection().catch(() => undefined)));
  await Promise.all(ALL_MODELS.map((m) => m.createIndexes()));
});

afterAll(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
