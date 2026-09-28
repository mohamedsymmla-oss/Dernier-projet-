import { BufferJSON, initAuthCreds, proto, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import { withTx, type Db } from '../db/pool.js';
import type { SecretBox } from '../lib/crypto.js';

/**
 * État d'authentification Baileys stocké dans PostgreSQL (table qr_auth), chaque valeur chiffrée
 * (AES-256-GCM, ENCRYPTION_KEY). Remplace useMultiFileAuthState : aucun fichier local, la session
 * survit aux redémarrages et aux redéploiements sans nouveau scan.
 */
export async function loadAuthState(db: Db, secrets: SecretBox, sessionId: string) {
  const encode = (v: unknown) => secrets.encrypt(JSON.stringify(v, BufferJSON.replacer));
  const decode = (enc: string) => JSON.parse(secrets.decrypt(enc), BufferJSON.reviver);

  const credsRow = await db.query('SELECT value_enc FROM qr_auth WHERE session_id=$1 AND key=$2', [sessionId, 'creds']);
  const creds = credsRow.rows[0] ? decode(credsRow.rows[0].value_enc) : initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        if (ids.length === 0) return out;
        const res = await db.query('SELECT key, value_enc FROM qr_auth WHERE session_id=$1 AND key = ANY($2::text[])', [
          sessionId,
          ids.map((id) => `${type}:${id}`),
        ]);
        const byKey = new Map(res.rows.map((r) => [r.key as string, r.value_enc as string]));
        for (const id of ids) {
          const enc = byKey.get(`${type}:${id}`);
          if (!enc) continue;
          let value = decode(enc);
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
          out[id] = value;
        }
        return out;
      },
      set: async (data) => {
        await withTx(db, async (tx) => {
          for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
            const entries = data[category] ?? {};
            for (const id of Object.keys(entries)) {
              const value = entries[id];
              const key = `${category}:${id}`;
              if (value) {
                await tx.query(
                  `INSERT INTO qr_auth (session_id, key, value_enc) VALUES ($1,$2,$3)
                   ON CONFLICT (session_id, key) DO UPDATE SET value_enc=EXCLUDED.value_enc, updated_at=now()`,
                  [sessionId, key, encode(value)],
                );
              } else {
                await tx.query('DELETE FROM qr_auth WHERE session_id=$1 AND key=$2', [sessionId, key]);
              }
            }
          }
        });
      },
    },
  };

  const saveCreds = async () => {
    await db.query(
      `INSERT INTO qr_auth (session_id, key, value_enc) VALUES ($1,'creds',$2)
       ON CONFLICT (session_id, key) DO UPDATE SET value_enc=EXCLUDED.value_enc, updated_at=now()`,
      [sessionId, encode(state.creds)],
    );
  };
  return { state, saveCreds };
}

/** Supprime toute trace de la session (déconnexion) : un nouveau scan sera nécessaire. */
export async function clearAuthState(db: Db, sessionId: string) {
  await db.query('DELETE FROM qr_auth WHERE session_id=$1', [sessionId]);
}
