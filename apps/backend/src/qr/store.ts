import { one, withTx, type DbClient } from '../db/pool.js';

export type QrStatus = 'WAITING_SCAN' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'LOGGED_OUT';

export interface QrSessionRow {
  id: string;
  connection_id: string;
  status: QrStatus;
  desired_state: 'RUNNING' | 'STOPPED';
  qr: string | null;
  qr_updated_at: Date | null;
  phone_number: string | null;
  push_name: string | null;
  paired_at: Date | null;
  connected_at: Date | null;
  disconnected_at: Date | null;
  last_disconnect_code: number | null;
  last_error: string | null;
  updated_at: Date;
}

/**
 * Session QR unique. Elle possède sa propre ligne provider_connections (provider = 'qr', sans clé API) :
 * les campagnes QR s'y rattachent, jamais à la connexion du fournisseur.
 */
export async function getOrCreateSession(db: DbClient): Promise<QrSessionRow> {
  const existing = await one<QrSessionRow>(db, 'SELECT * FROM qr_sessions ORDER BY created_at LIMIT 1');
  if (existing) return existing;
  return withTx(db as never, async (tx) => {
    const again = await one<QrSessionRow>(tx, 'SELECT * FROM qr_sessions ORDER BY created_at LIMIT 1 FOR UPDATE');
    if (again) return again;
    const conn = await one(
      tx,
      `INSERT INTO provider_connections (provider, label, mode, status, status_detail)
       VALUES ('qr', 'WhatsApp QR', 'PRODUCTION', 'DISCONNECTED', 'Scannez le QR code pour connecter') RETURNING id`,
    );
    return (await one<QrSessionRow>(tx, 'INSERT INTO qr_sessions (connection_id) VALUES ($1) RETURNING *', [conn!.id]))!;
  });
}

export async function getSession(db: DbClient): Promise<QrSessionRow | null> {
  return one<QrSessionRow>(db, 'SELECT * FROM qr_sessions ORDER BY created_at LIMIT 1');
}

const CONNECTION_STATUS: Record<QrStatus, string> = {
  WAITING_SCAN: 'UNVERIFIED',
  CONNECTING: 'UNVERIFIED',
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  LOGGED_OUT: 'DISCONNECTED',
};

/** Met à jour la session et, en miroir, le statut de sa connexion (utilisé par le moteur d'envoi). */
export async function updateSession(db: DbClient, id: string, patch: Partial<QrSessionRow>) {
  const keys = Object.keys(patch) as Array<keyof QrSessionRow>;
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  const row = await one<QrSessionRow>(
    db,
    `UPDATE qr_sessions SET ${sets}, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, ...keys.map((k) => patch[k])],
  );
  if (row) {
    await db.query(
      `UPDATE provider_connections SET status=$2, phone_number=coalesce($3, phone_number), status_detail=$4, updated_at=now() WHERE id=$1`,
      [row.connection_id, CONNECTION_STATUS[row.status], row.phone_number, row.last_error],
    );
  }
  return row;
}

export async function logQrEvent(db: DbClient, sessionId: string | null, type: string, detail: Record<string, unknown> = {}) {
  await db.query('INSERT INTO qr_events (session_id, type, detail) VALUES ($1,$2,$3)', [sessionId, type, JSON.stringify(detail)]);
}

/** Met en pause les campagnes QR en cours (déconnexion définitive, arrêt d'urgence). */
export async function pauseQrRuns(db: DbClient, reason: string) {
  await db.query(
    `UPDATE automation_runs SET status='PAUSED', paused_at=now(), pause_reason=$1, updated_at=now()
      WHERE channel='QR' AND status='RUNNING'`,
    [reason],
  );
}
