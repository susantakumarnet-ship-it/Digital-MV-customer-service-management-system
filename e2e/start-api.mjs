/* global process */
// Starts the API for end-to-end tests against a fresh throwaway database (never the Atlas database).
// Drops `mv_e2e`, runs migrations and the demo seed with known passwords, then starts the server.
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/api');
const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: '4710', // separate from the dev instance (4610) so both can run side by side
  MONGODB_URI: process.env.MONGODB_URI_TEST ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
  MONGODB_DB: 'mv_e2e',
  SEED_ADMIN_EMAIL: 'admin@e2e.local',
  SEED_ADMIN_PASSWORD: 'E2e-Admin-Passw0rd',
  SEED_DEMO_PASSWORD: 'E2e-Demo-Passw0rd',
  MAIL_TRANSPORT: 'none',
  // The suite signs in far more often than a real user; the production default (20) stays unchanged.
  LOGIN_RATE_LIMIT_PER_15_MIN: '1000',
  LOG_LEVEL: 'warn',
  // Fresh secrets per run: apps/api/.env is deliberately NOT loaded, so tests can never reach Atlas.
  JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
  MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};
const run = (cmd) => execSync(cmd, { cwd: apiDir, env, stdio: 'inherit' });

const { default: mongoose } = await import('mongoose');
await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB });
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
run('npx tsx src/db/migrate.ts up');
run('npx tsx src/db/seeds/run.ts --demo');
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: apiDir, env, stdio: 'inherit' });
process.on('SIGTERM', () => server.kill());
process.on('SIGINT', () => server.kill());
