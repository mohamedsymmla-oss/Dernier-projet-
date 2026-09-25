import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../migrations'), // src/db → migrations
    path.resolve(here, '../migrations'), // dist → migrations
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(process.cwd(), 'apps/backend/migrations'),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('Dossier migrations introuvable');
  return found;
}

/** Applique les migrations SQL non encore appliquées, sous verrou (plusieurs instances possibles). */
export async function runMigrations(db: Db, log: (m: string) => void = () => undefined): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const dir = migrationsDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
        log(`Migration appliquée : ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Échec migration ${f} : ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => undefined);
    client.release();
  }
  return applied;
}
