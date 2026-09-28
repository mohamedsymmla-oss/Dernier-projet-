import { spawn } from 'node:child_process';
import { parseBuffer } from 'music-metadata';
import { SENDZEN_MEDIA_LIMITS } from '@wa/provider-connectors';
import { one } from '../db/pool.js';
import type { AppContext } from '../context.js';
import { fetchPublicUrl } from '../services/media-probe.js';

export interface VoiceNote {
  data: Buffer;
  mime: string;
  seconds: number | null;
  converted: boolean;
}

function ffmpegToOpus(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1']);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg : ${Buffer.concat(err).toString().slice(0, 300)}`))));
    p.stdin.on('error', () => undefined);
    p.stdin.end(input);
  });
}

async function mediaBytes(ctx: AppContext, mediaId: string): Promise<Buffer> {
  const m = await one(ctx.db, 'SELECT source, storage_key, external_url FROM media_assets WHERE id=$1', [mediaId]);
  if (!m) throw new Error('Média introuvable');
  if (m.source === 'upload') return ctx.storage.get(m.storage_key);
  const f = await fetchPublicUrl(m.external_url, SENDZEN_MEDIA_LIMITS.maxAudioBytes, ctx.config.ALLOW_PRIVATE_MEDIA_URLS);
  if (!f.ok) throw new Error(f.error);
  return f.body;
}

/**
 * Audio prêt pour un vrai message vocal WhatsApp : OGG/Opus mono 48 kHz (conversion ffmpeg),
 * mis en cache en base pour ne convertir qu'une fois.
 */
export async function getVoiceNote(ctx: AppContext, mediaId: string): Promise<VoiceNote> {
  const cached = await one(ctx.db, `SELECT data, mime, seconds FROM qr_media_cache WHERE media_id=$1 AND variant='ogg_opus'`, [mediaId]);
  if (cached) return { data: cached.data, mime: cached.mime, seconds: cached.seconds, converted: true };
  const input = await mediaBytes(ctx, mediaId);
  if (!ctx.ffmpegAvailable) {
    const meta = await one(ctx.db, 'SELECT mime, duration_ms FROM media_assets WHERE id=$1', [mediaId]);
    return { data: input, mime: meta?.mime ?? 'audio/mpeg', seconds: meta?.duration_ms ? Math.round(meta.duration_ms / 1000) : null, converted: false };
  }
  const data = await ffmpegToOpus(input);
  let seconds: number | null = null;
  try {
    const meta = await parseBuffer(data, { mimeType: 'audio/ogg', size: data.length }, { duration: true });
    seconds = meta.format.duration ? Math.round(meta.format.duration) : null;
  } catch {
    seconds = null;
  }
  const mime = 'audio/ogg; codecs=opus';
  await ctx.db.query(
    `INSERT INTO qr_media_cache (media_id, variant, data, mime, seconds) VALUES ($1,'ogg_opus',$2,$3,$4) ON CONFLICT DO NOTHING`,
    [mediaId, data, mime, seconds],
  );
  return { data, mime, seconds, converted: true };
}
