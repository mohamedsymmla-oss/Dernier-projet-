import dns from 'node:dns';
import net from 'node:net';
import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';
import { parseBuffer } from 'music-metadata';
import { Agent, fetch as undiciFetch } from 'undici';
import { SENDZEN_MEDIA_LIMITS } from '@wa/provider-connectors';

export interface ProbeResult {
  ok: boolean;
  kind: 'audio' | 'image';
  mime: string | null;
  extension: string | null;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  providerCompatible: boolean;
  /** Pour l'audio : OGG/Opus est le format des notes vocales WhatsApp ; ne garantit PAS l'affichage en message vocal. */
  isOggOpus: boolean;
}

const AUDIO_MIME_ALIASES: Record<string, string> = {
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/mp3': 'audio/mpeg',
  'audio/opus': 'audio/ogg',
  'audio/x-aac': 'audio/aac',
  'audio/aacp': 'audio/aac',
};

export function normalizeMime(m: string | null | undefined): string | null {
  if (!m) return null;
  const base = m.split(';')[0]!.trim().toLowerCase();
  return AUDIO_MIME_ALIASES[base] ?? base;
}

export async function probeMedia(buf: Buffer, kind: 'audio' | 'image', declaredName: string, declaredMime?: string | null): Promise<ProbeResult> {
  const checks: ProbeResult['checks'] = [];
  const ext = (declaredName.split('.').pop() ?? '').toLowerCase() || null;
  const ft = await fileTypeFromBuffer(buf).catch(() => undefined);
  const detectedMime = normalizeMime(ft?.mime ?? null);
  const mime = detectedMime ?? normalizeMime(declaredMime);
  let durationMs: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let isOggOpus = false;

  const allowedMimes = kind === 'audio' ? SENDZEN_MEDIA_LIMITS.audioFormats : SENDZEN_MEDIA_LIMITS.imageFormats;
  const allowedExt = kind === 'audio' ? SENDZEN_MEDIA_LIMITS.audioExtensions : SENDZEN_MEDIA_LIMITS.imageExtensions;
  const maxBytes = kind === 'audio' ? SENDZEN_MEDIA_LIMITS.maxAudioBytes : SENDZEN_MEDIA_LIMITS.maxImageBytes;

  checks.push({
    label: 'Type réel du fichier (MIME)',
    ok: !!mime && allowedMimes.includes(mime),
    detail: mime ? `${mime}${detectedMime ? ' (détecté)' : ' (déclaré)'}` : 'Type non reconnu',
  });
  checks.push({
    label: 'Extension',
    ok: !ext || allowedExt.includes(ext) || !!detectedMime,
    detail: ext ? `.${ext}` : 'aucune',
  });
  checks.push({
    label: 'Taille',
    ok: buf.length > 0 && buf.length <= maxBytes,
    detail: `${(buf.length / 1024 / 1024).toFixed(2)} Mo (max ${maxBytes / 1024 / 1024} Mo)`,
  });

  if (kind === 'audio') {
    try {
      const meta = await parseBuffer(buf, { mimeType: mime ?? undefined, size: buf.length }, { duration: true });
      if (meta.format.duration) durationMs = Math.round(meta.format.duration * 1000);
      isOggOpus = mime === 'audio/ogg' && /opus/i.test(meta.format.codec ?? '');
      checks.push({ label: 'Lecture audio', ok: durationMs !== null && durationMs > 0, detail: durationMs ? `Durée ${formatMs(durationMs)}` : 'Durée illisible' });
    } catch (e) {
      checks.push({ label: 'Lecture audio', ok: false, detail: `Fichier audio illisible : ${(e as Error).message}` });
    }
  } else {
    try {
      const dim = imageSize(new Uint8Array(buf));
      width = dim.width ?? null;
      height = dim.height ?? null;
      checks.push({ label: 'Lecture image', ok: !!width && !!height, detail: `${width}×${height}` });
    } catch (e) {
      checks.push({ label: 'Lecture image', ok: false, detail: `Image illisible : ${(e as Error).message}` });
    }
  }
  const ok = checks.every((c) => c.ok);
  return {
    ok,
    kind,
    mime,
    extension: ft?.ext ?? ext,
    sizeBytes: buf.length,
    durationMs,
    width,
    height,
    checks,
    providerCompatible: ok,
    isOggOpus,
  };
}

export function formatMs(ms: number) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/**
 * Télécharge une URL publique avec protections : http(s) uniquement, IP privées refusées (SSRF),
 * taille maximale, délai maximal. Sert à vérifier que l'URL est accessible et que le média est valide.
 */
export async function fetchPublicUrl(url: string, maxBytes: number, allowPrivate = false) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL invalide');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Seules les URL http(s) sont acceptées');
  if (parsed.protocol === 'http:') {
    // WhatsApp télécharge le média lui-même : https est fortement recommandé
  }
  const agent = new Agent({
    connect: {
      lookup: (hostname, options, cb) => {
        dns.lookup(hostname, { ...options, all: false }, (err, address, family) => {
          if (err) return cb(err, '', 0);
          if (!allowPrivate && isPrivateIp(String(address))) return cb(new Error('Adresse privée refusée'), '', 0);
          cb(null, address as string, family as number);
        });
      },
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await undiciFetch(url, { dispatcher: agent, redirect: 'follow', signal: controller.signal });
    const contentType = res.headers.get('content-type');
    const declaredLength = Number(res.headers.get('content-length') ?? 0);
    if (!res.ok) return { ok: false as const, httpStatus: res.status, contentType, error: `Réponse HTTP ${res.status}` };
    if (declaredLength > maxBytes) return { ok: false as const, httpStatus: res.status, contentType, error: 'Fichier trop volumineux' };
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > maxBytes) {
        controller.abort();
        return { ok: false as const, httpStatus: res.status, contentType, error: 'Fichier trop volumineux' };
      }
      chunks.push(Buffer.from(chunk));
    }
    return { ok: true as const, httpStatus: res.status, contentType, body: Buffer.concat(chunks), finalUrl: res.url };
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'Délai dépassé' : ((e as Error).cause as Error)?.message ?? (e as Error).message;
    return { ok: false as const, httpStatus: null, contentType: null, error: `URL inaccessible : ${msg}` };
  } finally {
    clearTimeout(timer);
    await agent.close().catch(() => undefined);
  }
}
