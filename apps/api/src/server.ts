import { env } from './config/env';
import { createApp } from './app';
import { logger } from './common/logger';
import { connectDatabase, databaseStatus, disconnectDatabase } from './db/connection';

async function main() {
  const e = env();
  await connectDatabase();
  const db = await databaseStatus();
  if (!db.replicaSet) {
    logger.warn('MongoDB is not a replica set: multi-document transactions will fail. See docs/phase-1/03-decisions-register.md D-27.');
  }
  const app = createApp();
  const server = app.listen(e.PORT, () => {
    logger.info({ port: e.PORT, env: e.NODE_ENV }, `API listening on http://localhost:${e.PORT}/api/v1 (docs: /api/v1/docs)`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Port ${e.PORT} is already in use by another process. Set PORT in apps/api/.env to a free port.`
        : err.message,
    );
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
