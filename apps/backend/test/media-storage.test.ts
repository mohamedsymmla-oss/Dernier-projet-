import { execFileSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { one } from '../src/db/pool.js';
import { getVoiceNote } from '../src/qr/audio.js';
import { getMediaUrl } from '../src/services/media.js';
import { DatabaseStorage } from '../src/storage/storage.js';
import { closeDb, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: Awaited<ReturnType<typeof buildApp>>;
let token: string;
let storage: DatabaseStorage;
let now = Date.UTC(2026, 8, 29, 10, 0, 0);

/** Vrai fichier .opus (OGG/Opus), comme ceux exportés depuis WhatsApp. */
const opus = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1']);

function multipart(kind: string, filename: string, mime: string, body: Buffer) {
  const boundary = '----opus';
  return {
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

beforeEach(async () => {
  env = await createTestEnv();
  now = Date.UTC(2026, 8, 29, 10, 0, 0);
  storage = new DatabaseStorage(env.db, env.ctx.config, () => now);
  env.ctx.storage = storage;
  env.ctx.ffmpegAvailable = true;
  await createUser(env.ctx, 'moi@exemple.com', 'MotDePasseTresLong1');
  app = await buildApp(env.ctx);
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'moi@exemple.com', password: 'MotDePasseTresLong1' } });
  token = res.json().token;
});
afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe('Stockage des médias en base (sans S3)', () => {
  it('import d’un fichier .opus depuis le téléphone : accepté, vérifié et conservé en base', async () => {
    const caps = await app.inject({ method: 'GET', url: '/media/capabilities', headers: { authorization: `Bearer ${token}` } });
    expect(caps.json().uploadAvailable).toBe(true);

    const r = await app.inject({ method: 'POST', url: '/media/upload', ...multipart('audio', 'Audio 1.opus', 'application/octet-stream', opus) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ kind: 'audio', source: 'upload', mime: 'audio/ogg', status: 'VALID' });
    expect(r.json().validation.isOggOpus).toBe(true);
    const blob = await one(env.db, 'SELECT size_bytes, content_type FROM media_blobs');
    expect(blob).toMatchObject({ size_bytes: opus.length, content_type: 'audio/ogg' });

    // La vérification du contenu reste active : un faux .opus est refusé
    const bad = await app.inject({ method: 'POST', url: '/media/upload', ...multipart('audio', 'faux.opus', 'audio/ogg', Buffer.from('pas un audio')) });
    expect(bad.statusCode).toBe(400);
  });

  it('URL signée servie au fournisseur ; signature falsifiée ou expirée → 404', async () => {
    const up = await app.inject({ method: 'POST', url: '/media/upload', ...multipart('audio', 'a.opus', 'audio/ogg', opus) });
    const url = await getMediaUrl(env.ctx, up.json().id);
    expect(url).toMatch(/^https:\/\/backend\.test\/files\/media\/audio\/.+\.opus\?exp=\d+&sig=/);
    const path = url.replace('https://backend.test', '');

    const ok = await app.inject({ method: 'GET', url: path });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('audio/ogg');
    expect(ok.rawPayload.equals(opus)).toBe(true);

    expect((await app.inject({ method: 'GET', url: path.replace(/sig=.{4}/, 'sig=AAAA') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: path.split('?')[0]! })).statusCode).toBe(404);
    now += (env.ctx.config.MEDIA_URL_TTL_SECONDS + 60) * 1000;
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
  });

  it('WhatsApp QR : le .opus stocké en base est envoyé comme vrai message vocal', async () => {
    const up = await app.inject({ method: 'POST', url: '/media/upload', ...multipart('audio', 'a.opus', 'audio/ogg', opus) });
    const v = await getVoiceNote(env.ctx, up.json().id);
    expect(v.converted).toBe(true);
    expect(v.mime).toBe('audio/ogg; codecs=opus');
    expect(v.data.length).toBeGreaterThan(0);
  });

  it('suppression : le fichier est retiré de la base', async () => {
    const up = await app.inject({ method: 'POST', url: '/media/upload', ...multipart('audio', 'a.opus', 'audio/ogg', opus) });
    const del = await app.inject({ method: 'DELETE', url: `/media/${up.json().id}`, headers: { authorization: `Bearer ${token}` } });
    expect(del.statusCode).toBe(200);
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM media_blobs')).toMatchObject({ n: 0 });
  });
});
