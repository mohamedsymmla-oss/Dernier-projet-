import { z } from 'zod';
import { many, one, withTx } from '../db/pool.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from './audit.js';
import * as cfg from './automation-config.js';

/** Un préset ne contient JAMAIS d'informations de connexion fournisseur. */
export const presetPayloadSchema = z.object({
  delaySeconds: z.number().int().min(1).max(120).optional(),
  audioMediaId: z.string().uuid().nullable().optional(),
  photoMediaIds: z.array(z.string().uuid()).max(10).optional(),
  photoCount: z.number().int().min(1).max(10).optional(),
  text1: z.string().max(4096).optional(),
  text2: z.string().max(4096).optional(),
});
export type PresetPayload = z.infer<typeof presetPayloadSchema>;

export async function listPresets(ctx: AppContext, type?: string) {
  return many(ctx.db, `SELECT * FROM saved_presets ${type ? 'WHERE automation_type=$1' : ''} ORDER BY name`, type ? [type] : []);
}

export async function savePreset(ctx: AppContext, type: 'A1' | 'A2', name: string, payload: PresetPayload, userId?: string | null) {
  if (type === 'A1' && (payload.delaySeconds || payload.photoMediaIds || payload.photoCount)) {
    throw badRequest('Automation 1 : délai et photos non applicables');
  }
  if (type === 'A2' && (payload.text1 !== undefined || payload.text2 !== undefined)) throw badRequest('Automation 2 : pas de textes');
  const row = await one(
    ctx.db,
    `INSERT INTO saved_presets (automation_type, name, payload) VALUES ($1,$2,$3)
     ON CONFLICT (automation_type, name) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now() RETURNING *`,
    [type, name, JSON.stringify(payload)],
  );
  await audit(ctx.db, 'preset.saved', { userId, entityType: 'preset', entityId: row.id, details: { name } });
  return row;
}

/** Applique uniquement les champs présents dans le préset, un par un (isolation). */
export async function applyPreset(ctx: AppContext, id: string, userId?: string | null) {
  const preset = await one(ctx.db, 'SELECT * FROM saved_presets WHERE id=$1', [id]);
  if (!preset) throw notFound('Préset');
  const p = presetPayloadSchema.parse(preset.payload);
  const type = preset.automation_type as 'A1' | 'A2';
  await withTx(ctx.db, async (tx) => {
    if (p.audioMediaId !== undefined) await cfg.setAudio(tx, type, p.audioMediaId);
    if (type === 'A1') {
      if (p.text1 !== undefined) await cfg.setText(tx, 'text1', p.text1);
      if (p.text2 !== undefined) await cfg.setText(tx, 'text2', p.text2);
    } else {
      if (p.photoMediaIds !== undefined) await cfg.setPhotos(tx, p.photoMediaIds);
      if (p.photoCount !== undefined) await cfg.setPhotoCount(tx, p.photoCount);
      if (p.delaySeconds !== undefined) await cfg.setDelay(tx, p.delaySeconds);
    }
    await audit(tx, 'preset.applied', { userId, entityType: 'preset', entityId: id, details: { name: preset.name } });
  });
  return cfg.getConfig(ctx.db, type);
}

export async function deletePreset(ctx: AppContext, id: string) {
  await ctx.db.query('DELETE FROM saved_presets WHERE id=$1', [id]);
}
