import type { Channel } from '@wa/shared';
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

export async function listPresets(ctx: AppContext, type?: string, channel: Channel = 'PROVIDER') {
  return many(
    ctx.db,
    `SELECT * FROM saved_presets WHERE channel=$1 ${type ? 'AND automation_type=$2' : ''} ORDER BY name`,
    type ? [channel, type] : [channel],
  );
}

export async function savePreset(
  ctx: AppContext,
  type: 'A1' | 'A2',
  name: string,
  payload: PresetPayload,
  userId?: string | null,
  channel: Channel = 'PROVIDER',
) {
  if (type === 'A1' && (payload.photoMediaIds || payload.photoCount)) throw badRequest('Automation 1 : pas de photos');
  if (type === 'A1' && payload.delaySeconds && channel !== 'QR') throw badRequest('Automation 1 (fournisseur) : pas de délai');
  if (type === 'A2' && (payload.text1 !== undefined || payload.text2 !== undefined)) throw badRequest('Automation 2 : pas de textes');
  const row = await one(
    ctx.db,
    `INSERT INTO saved_presets (automation_type, name, payload, channel) VALUES ($1,$2,$3,$4)
     ON CONFLICT (channel, automation_type, name) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now() RETURNING *`,
    [type, name, JSON.stringify(payload), channel],
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
  const channel = preset.channel as Channel;
  await withTx(ctx.db, async (tx) => {
    if (p.audioMediaId !== undefined) await cfg.setAudio(tx, type, p.audioMediaId, channel);
    if (type === 'A1') {
      if (p.text1 !== undefined) await cfg.setText(tx, 'text1', p.text1, channel);
      if (p.text2 !== undefined) await cfg.setText(tx, 'text2', p.text2, channel);
      if (p.delaySeconds !== undefined && channel === 'QR') await cfg.setDelay(tx, p.delaySeconds, channel, 'A1');
    } else {
      if (p.photoMediaIds !== undefined) await cfg.setPhotos(tx, p.photoMediaIds, channel);
      if (p.photoCount !== undefined) await cfg.setPhotoCount(tx, p.photoCount, channel);
      if (p.delaySeconds !== undefined) await cfg.setDelay(tx, p.delaySeconds, channel, 'A2');
    }
    await audit(tx, 'preset.applied', { userId, entityType: 'preset', entityId: id, details: { name: preset.name } });
  });
  return cfg.getConfig(ctx.db, type, channel);
}

export async function deletePreset(ctx: AppContext, id: string) {
  await ctx.db.query('DELETE FROM saved_presets WHERE id=$1', [id]);
}
