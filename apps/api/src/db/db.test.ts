import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDb } from '../test-db.js';
import { toVectorLiteral, type Db } from './client.js';
import { migrate } from './migrate.js';

describe('Datenbank', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => db.close());

  it('wendet Migrationen genau einmal an', async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it('liefert Datum, Zähler und Zeitstempel einheitlich', async () => {
    const family = '11111111-1111-4111-8111-111111111111';
    const doc = await db.one<{
      id: string;
      valid_until: string;
      size_bytes: number;
      created_at: string;
    }>(
      `INSERT INTO documents (family_id, title, category, filename, mime, size_bytes, sha256, storage_path, content_text, extraction_method, valid_until)
       VALUES ($1, 'T', 'product', 'a.txt', 'text/plain', 12, 'x', '/x', 'inhalt', 'text', '2027-03-31') RETURNING *`,
      [family],
    );
    expect(doc?.valid_until).toBe('2027-03-31');
    expect(typeof doc?.size_bytes).toBe('number');
    expect(doc?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('speichert Vektoren und sucht per Kosinusabstand', async () => {
    const doc = await db.one<{ id: string }>('SELECT id FROM documents LIMIT 1');
    const a = new Array(384).fill(0);
    a[0] = 1;
    const b = new Array(384).fill(0);
    b[1] = 1;
    for (const [i, v] of [a, b].entries()) {
      await db.query(
        `INSERT INTO chunks (document_id, ordinal, content, embedding) VALUES ($1, $2, $3, $4::vector)`,
        [doc?.id, i, `chunk ${i}`, toVectorLiteral(v)],
      );
    }
    const rows = await db.query<{ content: string }>(
      `SELECT content FROM chunks ORDER BY embedding <=> $1::vector LIMIT 1`,
      [toVectorLiteral(b)],
    );
    expect(rows[0]?.content).toBe('chunk 1');
  });

  it('durchsucht deutschen und englischen Text im Volltext', async () => {
    await db.query(
      `INSERT INTO chunks (document_id, ordinal, content) SELECT id, 9, 'Wir erbringen Dienstleistungen im Rechenzentrum' FROM documents LIMIT 1`,
    );
    await db.query(
      `INSERT INTO chunks (document_id, ordinal, content) SELECT id, 10, 'Servers are operated in the data center' FROM documents LIMIT 1`,
    );
    const de = await db.query(
      `SELECT 1 FROM chunks WHERE tsv @@ to_tsquery('german', 'Dienstleistung')`,
    );
    const en = await db.query(`SELECT 1 FROM chunks WHERE tsv @@ to_tsquery('english', 'operate')`);
    expect(de.length).toBe(1);
    expect(en.length).toBe(1);
  });

  it('rollt Transaktionen bei Fehlern zurück', async () => {
    await expect(
      db.tx(async (tx) => {
        await tx.query(`INSERT INTO bids (name, customer) VALUES ('X', 'Y')`);
        throw new Error('abbruch');
      }),
    ).rejects.toThrow('abbruch');
    expect((await db.query('SELECT 1 FROM bids')).length).toBe(0);
  });
});
