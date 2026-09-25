import type { DbClient } from '../db/pool.js';

export async function audit(
  db: DbClient,
  action: string,
  opts: { userId?: string | null; entityType?: string; entityId?: string | null; details?: Record<string, unknown> } = {},
) {
  await db.query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)`,
    [opts.userId ?? null, action, opts.entityType ?? null, opts.entityId ?? null, JSON.stringify(opts.details ?? {})],
  );
}
