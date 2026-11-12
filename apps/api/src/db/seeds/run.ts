import { password as passwordPolicy } from '@mv/shared';
import { env } from '../../config/env';
import { connectDatabase, disconnectDatabase } from '../connection';
import { seedBase } from './base';
import { seedDemo } from './demo';

/**
 * Usage:
 *   npm run seed        → settings, system roles, workflows, first administrator (idempotent)
 *   npm run seed:demo   → the above + fictional demo master data and one user per role (not in production)
 */
async function main() {
  const e = env();
  const demo = process.argv.includes('--demo');
  const log = (m: string) => console.log(m);

  if (e.SEED_ADMIN_PASSWORD) {
    const p = passwordPolicy.safeParse(e.SEED_ADMIN_PASSWORD);
    if (!p.success) throw new Error(`SEED_ADMIN_PASSWORD: ${p.error.issues[0].message}`);
  }
  if (demo) {
    if (e.NODE_ENV === 'production') throw new Error('Demo data cannot be seeded in production.');
    if (!e.SEED_DEMO_PASSWORD) throw new Error('Set SEED_DEMO_PASSWORD to seed demo users.');
    const p = passwordPolicy.safeParse(e.SEED_DEMO_PASSWORD);
    if (!p.success) throw new Error(`SEED_DEMO_PASSWORD: ${p.error.issues[0].message}`);
  }

  await connectDatabase();
  console.log(`Seeding database "${e.MONGODB_DB}"…`);
  await seedBase(log, e.SEED_ADMIN_EMAIL, e.SEED_ADMIN_PASSWORD);
  if (demo) await seedDemo(log, e.SEED_DEMO_PASSWORD!);
  console.log('Seed complete.');
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
