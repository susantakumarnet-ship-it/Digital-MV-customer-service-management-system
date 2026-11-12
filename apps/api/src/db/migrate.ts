import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from './connection';
import { MIGRATIONS } from './migrations';

/**
 * Minimal migration runner.  Usage: migrate.ts up | down | status
 * Applied migrations are recorded in the `migrations` collection.
 */
async function main() {
  const cmd = process.argv[2] ?? 'status';
  await connectDatabase();
  const db = mongoose.connection.db!;
  const col = db.collection<{ _id: string; description: string; appliedAt: Date }>('migrations');
  const applied = new Set((await col.find().toArray()).map((m) => m._id));

  if (cmd === 'status') {
    for (const m of MIGRATIONS) console.log(`${applied.has(m.id) ? '[x]' : '[ ]'} ${m.id} — ${m.description}`);
  } else if (cmd === 'up') {
    let n = 0;
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      console.log(`Applying ${m.id} …`);
      await m.up(db);
      await col.insertOne({ _id: m.id, description: m.description, appliedAt: new Date() });
      n++;
    }
    console.log(n ? `Applied ${n} migration(s).` : 'Database is up to date.');
  } else if (cmd === 'down') {
    const last = [...MIGRATIONS].reverse().find((m) => applied.has(m.id));
    if (!last) console.log('Nothing to roll back.');
    else {
      console.log(`Rolling back ${last.id} …`);
      await last.down(db);
      await col.deleteOne({ _id: last.id });
    }
  } else {
    throw new Error(`Unknown command "${cmd}". Use up | down | status.`);
  }
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
