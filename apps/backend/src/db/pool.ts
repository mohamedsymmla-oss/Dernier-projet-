import pg from 'pg';

// Les colonnes bigint/numeric sont renvoyées en nombre (compteurs).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;

export function createPool(url: string, ssl = false): Db {
  return new pg.Pool({
    connectionString: url,
    max: 15,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
}

export async function withTx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T = any>(db: DbClient, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(db: DbClient, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params);
  return r.rows as T[];
}
