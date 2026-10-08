import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Im Quellbaum liegen die Migrationen neben diesem Modul, im Bundle unter dist/migrations. */
function migrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.join(here, 'migrations'),
    path.join(here, '..', 'migrations'),
    path.join(here, 'db', 'migrations'),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((dir) => existsSync(dir));
  if (!found)
    throw new Error(`Migrationsverzeichnis nicht gefunden (geprüft: ${candidates.join(', ')})`);
  return found;
}

export async function migrate(db: Db): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name),
  );
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    // pgvector legt Typen an; DDL und Eintrag gehören in dieselbe Transaktion,
    // damit ein Fehler keine halbe Migration zurücklässt.
    await db.tx(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}
