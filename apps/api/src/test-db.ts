import { randomBytes } from 'node:crypto';
import { openDb, type Db } from './db/client.js';
import { migrate } from './db/migrate.js';

/**
 * Datenbank für Tests. Standard ist eine flüchtige eingebettete Instanz (PGlite). Mit
 * TEST_DATABASE_URL läuft derselbe Testbestand gegen echtes Postgres — wie im Betrieb, mit anderem
 * Treiber und anderer Typabbildung.
 *
 * Testdateien laufen parallel; jede bekommt deshalb ein eigenes Schema (die Erweiterung `vector` liegt
 * einmalig in `public` und ist über den search_path erreichbar). `close()` räumt das Schema wieder ab.
 */
export async function openTestDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const db = await openDb('memory');
    await migrate(db);
    return db;
  }

  const admin = await openDb(url);
  await admin.exec('CREATE EXTENSION IF NOT EXISTS vector');
  const schema = `t_${randomBytes(6).toString('hex')}`;
  await admin.exec(`CREATE SCHEMA ${schema}`);

  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path=${schema},public`);
  const db = await openDb(scoped.toString());
  await migrate(db);

  const close = db.close.bind(db);
  db.close = async () => {
    await close();
    await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  };
  return db;
}
