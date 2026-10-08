import { mkdirSync } from 'node:fs';
import { PGlite, types as pgliteTypes } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import pg from 'pg';

export type Row = Record<string, unknown>;

/**
 * Schmale Datenbankschnittstelle. Hinter ihr liegt im Betrieb ein Postgres-Pool,
 * in Entwicklung und Tests eine eingebettete Postgres-Instanz (PGlite) mit
 * derselben SQL-Dialektik und denselben Erweiterungen (pgvector).
 */
export interface Db {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Mehrere Anweisungen ohne Parameter (Migrationen). */
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'pglite' | 'postgres';
}

const iso = (v: string): string => new Date(v).toISOString();

// Beide Treiber liefern int8, date und timestamptz sonst unterschiedlich
// (String, Date, BigInt). Eine einheitliche Darstellung hält den Rest des
// Codes frei von Fallunterscheidungen.
function configurePg(): void {
  pg.types.setTypeParser(20, (v) => Number(v)); // int8
  pg.types.setTypeParser(1082, (v) => v); // date → 'JJJJ-MM-TT'
  pg.types.setTypeParser(1184, iso); // timestamptz
}

class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  constructor(private readonly pg: Pick<PGlite, 'query' | 'exec'>, private readonly root?: PGlite) {}

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pg.query<T>(sql, params);
    return res.rows;
  }
  async one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null;
  }
  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!this.root) throw new Error('Verschachtelte Transaktionen werden nicht unterstützt');
    return this.root.transaction(async (t) => fn(new PgliteDb(t)));
  }
  async close(): Promise<void> {
    await this.root?.close();
  }
}

class PostgresDb implements Db {
  readonly kind = 'postgres' as const;
  constructor(private readonly target: pg.Pool | pg.PoolClient, private readonly pool?: pg.Pool) {}

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.target.query(sql, params);
    return res.rows as T[];
  }
  async one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null;
  }
  async exec(sql: string): Promise<void> {
    // Ohne Parameter nutzt node-postgres das einfache Protokoll, das mehrere Anweisungen erlaubt.
    await this.target.query(sql);
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('Verschachtelte Transaktionen werden nicht unterstützt');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PostgresDb(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> {
    await this.pool?.end();
  }
}

/**
 * `postgres://…` öffnet einen Pool, `memory` eine flüchtige eingebettete
 * Datenbank, alles andere gilt als Verzeichnis für die eingebettete Datenbank.
 */
export async function openDb(databaseUrl: string): Promise<Db> {
  if (/^postgres(ql)?:\/\//.test(databaseUrl)) {
    configurePg();
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    return new PostgresDb(pool, pool);
  }
  if (databaseUrl !== 'memory') mkdirSync(databaseUrl, { recursive: true });
  const lite = await PGlite.create(databaseUrl === 'memory' ? undefined : databaseUrl, {
    extensions: { vector },
    parsers: {
      [pgliteTypes.INT8]: (v: string) => Number(v),
      [pgliteTypes.DATE]: (v: string) => v,
      [pgliteTypes.TIMESTAMPTZ]: iso,
    },
  });
  return new PgliteDb(lite, lite);
}

/** pgvector erwartet Vektoren als Text `[0.1,0.2,…]`. */
export function toVectorLiteral(values: ArrayLike<number>): string {
  return `[${Array.from(values, (v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}
