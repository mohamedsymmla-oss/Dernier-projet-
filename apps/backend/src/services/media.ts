import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SENDZEN_MEDIA_LIMITS } from '@wa/provider-connectors';
import { many, one, withTx } from '../db/pool.js';
import type { AppContext } from '../context.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from './audit.js';
import { fetchPublicUrl, probeMedia, type ProbeResult } from './media-probe.js';

const execFileP = promisify(execFile);

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileP('ffmpeg', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function validationJson(p: ProbeResult, extra: Record<string, unknown> = {}) {
  return { checks: p.checks, isOggOpus: p.isOggOpus, providerCompatible: p.providerCompatible, ...extra };
}

export async function uploadMedia(
  ctx: AppContext,
  input: { kind: 'audio' | 'image'; filename: string; mime?: string | null; body: Buffer; userId?: string | null },
) {
  if (!ctx.storage.configured) throw badRequest("Stockage des fichiers « À configurer » (variables S3_*) : utilisez une URL publique");
  const probe = await probeMedia(input.body, input.kind, input.filename, input.mime);
  if (!probe.ok) throw badRequest('Média refusé', probe.checks.filter((c) => !c.ok));
  const hash = sha256(input.body);
  const key = `media/${input.kind}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${probe.extension ?? 'bin'}`;
  await ctx.storage.put(key, input.body, probe.mime ?? 'application/octet-stream');
  const row = await one(
    ctx.db,
    `INSERT INTO media_assets (kind, source, name, storage_key, mime, extension, size_bytes, duration_ms, width, height, sha256, status, validation)
     VALUES ($1,'upload',$2,$3,$4,$5,$6,$7,$8,$9,$10,'VALID',$11) RETURNING *`,
    [input.kind, input.filename.slice(0, 200), key, probe.mime, probe.extension, probe.sizeBytes, probe.durationMs, probe.width, probe.height, hash, JSON.stringify(validationJson(probe))],
  );
  await audit(ctx.db, 'media.uploaded', { userId: input.userId, entityType: 'media', entityId: row.id, details: { name: row.name } });
  return row;
}

export async function addMediaFromUrl(ctx: AppContext, input: { kind: 'audio' | 'image'; url: string; name?: string; userId?: string | null }) {
  const max = input.kind === 'audio' ? SENDZEN_MEDIA_LIMITS.maxAudioBytes : SENDZEN_MEDIA_LIMITS.maxImageBytes;
  const fetched = await fetchPublicUrl(input.url, max, ctx.config.ALLOW_PRIVATE_MEDIA_URLS);
  if (!fetched.ok) {
    throw badRequest('URL refusée', [{ label: 'URL accessible', ok: false, detail: fetched.error + (fetched.httpStatus ? ` (HTTP ${fetched.httpStatus})` : '') }]);
  }
  const name = input.name || decodeURIComponent(new URL(input.url).pathname.split('/').pop() || 'media');
  const probe = await probeMedia(fetched.body, input.kind, name, fetched.contentType);
  probe.checks.unshift({ label: 'URL accessible', ok: true, detail: `HTTP ${fetched.httpStatus}` });
  if (!input.url.startsWith('https://')) {
    probe.checks.push({ label: 'HTTPS', ok: false, detail: 'Le fournisseur exige généralement une URL https' });
  }
  const ok = probe.checks.every((c) => c.ok);
  if (!ok) throw badRequest('Média refusé', probe.checks.filter((c) => !c.ok));
  const row = await one(
    ctx.db,
    `INSERT INTO media_assets (kind, source, name, external_url, mime, extension, size_bytes, duration_ms, width, height, sha256, status, validation)
     VALUES ($1,'url',$2,$3,$4,$5,$6,$7,$8,$9,$10,'VALID',$11) RETURNING *`,
    [input.kind, name.slice(0, 200), input.url, probe.mime, probe.extension, probe.sizeBytes, probe.durationMs, probe.width, probe.height, sha256(fetched.body), JSON.stringify(validationJson(probe, { contentType: fetched.contentType }))],
  );
  await audit(ctx.db, 'media.url_added', { userId: input.userId, entityType: 'media', entityId: row.id, details: { url: input.url } });
  return row;
}

/** Où un média est utilisé : réglages, présets, campagnes actives. */
export async function mediaUsage(ctx: AppContext, mediaId: string) {
  const usage: string[] = [];
  const cfgs = await many(ctx.db, 'SELECT * FROM automation_configs');
  for (const c of cfgs) {
    const label = c.automation_type === 'A1' ? 'Automation 1' : 'Automation 2';
    if (c.audio_media_id === mediaId) usage.push(`${label} : audio`);
    const idx = (c.photo_media_ids as string[]).indexOf(mediaId);
    if (idx >= 0 && c.automation_type === 'A2') usage.push(`${label} : photo ${idx + 1}`);
  }
  const presets = await many(ctx.db, `SELECT name FROM saved_presets WHERE payload::text LIKE '%' || $1 || '%'`, [mediaId]);
  for (const p of presets) usage.push(`Préset « ${p.name} »`);
  const runs = await many(
    ctx.db,
    `SELECT id, automation_type FROM automation_runs WHERE status IN ('RUNNING','PAUSED') AND config_snapshot::text LIKE '%' || $1 || '%'`,
    [mediaId],
  );
  for (const r of runs) usage.push(`Campagne ${r.automation_type === 'A1' ? 'Automation 1' : 'Automation 2'} en cours`);
  return { usage, activeRuns: runs.length };
}

export function publicMedia(m: any, usage?: string[]) {
  return {
    id: m.id,
    kind: m.kind,
    source: m.source,
    name: m.name,
    mime: m.mime,
    extension: m.extension,
    sizeBytes: m.size_bytes,
    durationMs: m.duration_ms,
    width: m.width,
    height: m.height,
    status: m.status,
    validation: m.validation,
    externalUrl: m.source === 'url' ? m.external_url : null,
    derivedFrom: m.derived_from,
    createdAt: m.created_at,
    usedIn: usage,
  };
}

export async function listMedia(ctx: AppContext, kind?: 'audio' | 'image') {
  const rows = await many(
    ctx.db,
    `SELECT * FROM media_assets WHERE deleted_at IS NULL ${kind ? 'AND kind=$1' : ''} ORDER BY created_at DESC`,
    kind ? [kind] : [],
  );
  return Promise.all(rows.map(async (r) => publicMedia(r, (await mediaUsage(ctx, r.id)).usage)));
}

export async function getMediaUrl(ctx: AppContext, id: string) {
  const m = await one(ctx.db, 'SELECT * FROM media_assets WHERE id=$1', [id]);
  if (!m) throw notFound('Média');
  if (m.source === 'url') return m.external_url as string;
  return ctx.storage.publicUrl(m.storage_key);
}

/**
 * Suppression : refusée si le média est utilisé par une campagne en cours ou un réglage
 * (pour ne pas casser une automatisation). L'historique des campagnes passées est conservé.
 */
export async function deleteMedia(ctx: AppContext, id: string, userId?: string | null, force = false) {
  const m = await one(ctx.db, 'SELECT * FROM media_assets WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!m) throw notFound('Média');
  const { usage, activeRuns } = await mediaUsage(ctx, id);
  if (activeRuns > 0) throw conflict('Média utilisé par une campagne en cours : arrêtez-la ou attendez sa fin', usage);
  if (usage.length > 0 && !force) throw conflict('Média utilisé : retirez-le des automatisations ou confirmez la suppression', usage);
  await withTx(ctx.db, async (tx) => {
    await tx.query(`UPDATE automation_configs SET audio_media_id=NULL, content_version=content_version+1 WHERE audio_media_id=$1`, [id]);
    await tx.query(
      `UPDATE automation_configs SET photo_media_ids=array_remove(photo_media_ids, $1::uuid), content_version=content_version+1
        WHERE $1::uuid = ANY(photo_media_ids)`,
      [id],
    );
    await tx.query('UPDATE media_assets SET deleted_at=now() WHERE id=$1', [id]);
    await audit(tx, 'media.deleted', { userId, entityType: 'media', entityId: id, details: { name: m.name, usage } });
  });
  if (m.storage_key) await ctx.storage.delete(m.storage_key).catch((e) => ctx.log.warn({ err: e }, 'storage_delete_failed'));
  return { deleted: true, detachedFrom: usage };
}

/** Remplace un média partout où il est utilisé (réglages), sans toucher aux autres paramètres. */
export async function replaceMedia(ctx: AppContext, oldId: string, newId: string, userId?: string | null) {
  const [oldM, newM] = await Promise.all([
    one(ctx.db, 'SELECT * FROM media_assets WHERE id=$1 AND deleted_at IS NULL', [oldId]),
    one(ctx.db, 'SELECT * FROM media_assets WHERE id=$1 AND deleted_at IS NULL', [newId]),
  ]);
  if (!oldM || !newM) throw notFound('Média');
  if (oldM.kind !== newM.kind) throw badRequest('Le remplacement doit être du même type (audio ↔ audio, image ↔ image)');
  await withTx(ctx.db, async (tx) => {
    await tx.query(`UPDATE automation_configs SET audio_media_id=$2, content_version=content_version+1 WHERE audio_media_id=$1`, [oldId, newId]);
    await tx.query(
      `UPDATE automation_configs SET photo_media_ids=array_replace(photo_media_ids, $1::uuid, $2::uuid), content_version=content_version+1
        WHERE $1::uuid = ANY(photo_media_ids)`,
      [oldId, newId],
    );
    await audit(tx, 'media.replaced', { userId, entityType: 'media', entityId: oldId, details: { newId } });
  });
  const { activeRuns } = await mediaUsage(ctx, oldId);
  if (activeRuns === 0) await deleteMedia(ctx, oldId, userId, true).catch(() => undefined);
  return publicMedia(newM);
}

/**
 * Conversion FFmpeg vers OGG/Opus (format des notes vocales WhatsApp).
 * N'est PAS une garantie d'affichage en message vocal : cela dépend du fournisseur.
 */
export async function convertToOggOpus(ctx: AppContext, id: string, userId?: string | null) {
  if (!ctx.ffmpegAvailable) throw badRequest('FFmpeg non installé sur le serveur : conversion non disponible');
  if (!ctx.storage.configured) throw badRequest('Stockage non configuré : conversion impossible');
  const m = await one(ctx.db, 'SELECT * FROM media_assets WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!m || m.kind !== 'audio') throw notFound('Audio');
  const input =
    m.source === 'upload'
      ? await ctx.storage.get(m.storage_key)
      : await (async () => {
          const f = await fetchPublicUrl(m.external_url, SENDZEN_MEDIA_LIMITS.maxAudioBytes, ctx.config.ALLOW_PRIVATE_MEDIA_URLS);
          if (!f.ok) throw badRequest(f.error);
          return f.body;
        })();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conv-'));
  try {
    const inPath = path.join(dir, 'in');
    const outPath = path.join(dir, 'out.ogg');
    await fs.writeFile(inPath, input);
    await execFileP('ffmpeg', ['-y', '-i', inPath, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', outPath], {
      timeout: 120_000,
    });
    const out = await fs.readFile(outPath);
    const name = m.name.replace(/\.[^.]+$/, '') + '.ogg';
    const row = await uploadMedia(ctx, { kind: 'audio', filename: name, mime: 'audio/ogg', body: out, userId });
    await ctx.db.query('UPDATE media_assets SET derived_from=$2 WHERE id=$1', [row.id, id]);
    return { ...row, derived_from: id };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
