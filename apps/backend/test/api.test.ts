import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { signSendZenPayload } from '@wa/provider-connectors';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { many, one } from '../src/db/pool.js';
import { syncMissedEvents } from '../src/services/webhooks.js';
import { closeDb, createTestEnv, drainRecipients, drainWebhooks, phones, seedA1Config, seedConnection, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: Awaited<ReturnType<typeof buildApp>>;
let token: string;
let conn: any;

beforeEach(async () => {
  env = await createTestEnv();
  conn = await seedConnection(env);
  await createUser(env.ctx, 'moi@exemple.com', 'MotDePasseTresLong1');
  app = await buildApp(env.ctx);
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'moi@exemple.com', password: 'MotDePasseTresLong1' } });
  token = res.json().token;
});
afterAll(async () => {
  await app?.close();
  await closeDb();
});

const auth = () => ({ authorization: `Bearer ${token}` });

function webhookPayload(opts: { inbound?: { id: string; from: string; ts: number }[]; statuses?: { id: string; status: string; ts: number; code?: number }[] }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '22370000000', phone_number_id: 'pn-1' },
              messages: (opts.inbound ?? []).map((m) => ({ from: m.from.slice(1), id: m.id, timestamp: String(Math.floor(m.ts / 1000)), type: 'text', text: { body: 'Oui' } })),
              statuses: (opts.statuses ?? []).map((s) => ({
                id: s.id,
                status: s.status,
                timestamp: String(Math.floor(s.ts / 1000)),
                recipient_id: '22376000000',
                ...(s.code ? { errors: [{ code: s.code, title: 'err' }] } : {}),
              })),
            },
          },
        ],
      },
    ],
  };
}

async function postWebhook(payload: unknown, secret: string | null = 'test-secret') {
  const raw = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: `/webhooks/sendzen/${conn.id}`,
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-hub-signature-256': signSendZenPayload(raw, secret) } : {}) },
    payload: raw,
  });
}

describe('Sécurité', () => {
  it('routes protégées sans session → 401', async () => {
    for (const url of ['/dashboard', '/connections', '/contacts', '/automations/A1/config', '/logs/provider']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(401);
    }
  });
  it('mauvais mot de passe refusé ; déconnexion révoque la session', async () => {
    const bad = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'moi@exemple.com', password: 'faux-mot-de-passe' } });
    expect(bad.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: auth() })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/auth/logout', headers: auth() });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: auth() })).statusCode).toBe(401);
  });
  it('rate limiting sur la connexion', async () => {
    const codes = [];
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'x@exemple.com', password: 'nope-nope-nope' } });
      codes.push(r.statusCode);
    }
    expect(codes).toContain(429);
  });
  it('la clé API n’est jamais renvoyée en clair, seulement masquée', async () => {
    const r = await app.inject({ method: 'GET', url: '/connections', headers: auth() });
    const body = r.body;
    expect(body).not.toContain('sk_live_secret_key_789');
    expect(body).not.toContain('api_key_enc');
    expect(r.json()[0].apiKeyHint).toBe('sk_live_***789');
    const row = await one(env.db, 'SELECT api_key_enc FROM provider_connections');
    expect(row.api_key_enc).not.toContain('sk_live');
    expect(env.ctx.secrets.decrypt(row.api_key_enc)).toBe('sk_live_secret_key_789');
  });
  it('health check', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.json()).toMatchObject({ backend: { ok: true }, database: { ok: true } });
  });
});

describe('Webhooks', () => {
  it('signature invalide ou absente → 401 quand un secret est configuré', async () => {
    const p = webhookPayload({ inbound: [{ id: 'wamid.X', from: '+22376000001', ts: Date.now() }] });
    expect((await postWebhook(p, 'mauvais')).statusCode).toBe(401);
    expect((await postWebhook(p, null)).statusCode).toBe(401);
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM webhook_events')).toMatchObject({ n: 0 });
  });

  it('webhook dupliqué : stocké une fois, traité une fois', async () => {
    const p = webhookPayload({ inbound: [{ id: 'wamid.IN1', from: '+22376000001', ts: Date.now() }] });
    const r1 = await postWebhook(p);
    const r2 = await postWebhook(p);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().duplicate).toBe(true);
    await drainWebhooks(env);
    expect(await one(env.db, 'SELECT count(*)::int AS n, max(duplicate_count)::int AS d FROM webhook_events')).toMatchObject({ n: 1, d: 1 });
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM inbound_messages')).toMatchObject({ n: 1 });
  });

  it('même message renvoyé dans un payload différent (autre enveloppe) : appliqué une seule fois', async () => {
    const m = { id: 'wamid.SAME', from: '+22376000002', ts: Date.now() };
    await postWebhook(webhookPayload({ inbound: [m] }));
    await postWebhook({ ...webhookPayload({ inbound: [m] }), extra: 'retry' });
    await drainWebhooks(env);
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM webhook_events')).toMatchObject({ n: 2 });
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM inbound_messages')).toMatchObject({ n: 1 });
  });

  it('statuts : accepté → livré → lu, jamais rétrogradé (webhooks désordonnés)', async () => {
    await seedA1Config(env);
    const { createImport } = await import('../src/services/imports.js');
    const { createRun } = await import('../src/services/runs.js');
    const imp = await createImport(env.ctx, { automationType: 'A1', source: 'paste', content: phones(1).join('\n') });
    await createRun(env.ctx, { type: 'A1', kind: 'SEQUENCE', importId: imp.importId, clientRequestId: 'st-1' });
    await drainRecipients(env);
    const audioId = env.fake.sends[0]!.providerMessageId;
    const t = Date.now();
    await postWebhook(webhookPayload({ statuses: [{ id: audioId, status: 'read', ts: t + 3000 }] }));
    await postWebhook(webhookPayload({ statuses: [{ id: audioId, status: 'delivered', ts: t + 2000 }] }));
    await postWebhook(webhookPayload({ statuses: [{ id: audioId, status: 'sent', ts: t + 1000 }] }));
    await drainWebhooks(env);
    const m = await one(env.db, 'SELECT status, sent_at, delivered_at, read_at FROM outbound_messages WHERE provider_message_id=$1', [audioId]);
    expect(m.status).toBe('READ');
    expect(m.sent_at && m.delivered_at && m.read_at).toBeTruthy();
  });

  it('échec de livraison 131047 : modèle requis', async () => {
    await seedA1Config(env);
    const { createImport } = await import('../src/services/imports.js');
    const { createRun } = await import('../src/services/runs.js');
    const imp = await createImport(env.ctx, { automationType: 'A1', source: 'paste', content: phones(1).join('\n') });
    await createRun(env.ctx, { type: 'A1', kind: 'SEQUENCE', importId: imp.importId, clientRequestId: 'st-2' });
    await drainRecipients(env);
    await postWebhook(webhookPayload({ statuses: [{ id: env.fake.sends[1]!.providerMessageId, status: 'failed', ts: Date.now(), code: 131047 }] }));
    await drainWebhooks(env);
    const c = await one(env.db, 'SELECT a1_status FROM contacts WHERE phone_e164=$1', [phones(1)[0]]);
    expect(c.a1_status).toBe('TEMPLATE_REQUIRED');
    const r = await one(env.db, 'SELECT delivery_failed FROM automation_recipients');
    expect(r.delivery_failed).toBe(true);
  });

  it('détection de réponse après Automation 1', async () => {
    await seedA1Config(env);
    const { createImport } = await import('../src/services/imports.js');
    const { createRun } = await import('../src/services/runs.js');
    const [p] = phones(1);
    // Message reçu AVANT Automation 1 : ne compte pas comme réponse
    await postWebhook(webhookPayload({ inbound: [{ id: 'wamid.BEFORE', from: p!, ts: env.clock.t - 3600_000 }] }));
    await drainWebhooks(env);
    const imp = await createImport(env.ctx, { automationType: 'A1', source: 'paste', content: p! });
    await createRun(env.ctx, { type: 'A1', kind: 'SEQUENCE', importId: imp.importId, clientRequestId: 'resp-1' });
    await drainRecipients(env);
    let c = await one(env.db, 'SELECT responded_after_a1 FROM contacts WHERE phone_e164=$1', [p]);
    expect(c.responded_after_a1).toBe(false);
    await postWebhook(webhookPayload({ inbound: [{ id: 'wamid.AFTER', from: p!, ts: env.clock.t + 60_000 }] }));
    await drainWebhooks(env);
    c = await one(env.db, 'SELECT * FROM contacts WHERE phone_e164=$1', [p]);
    expect(c).toMatchObject({ responded_after_a1: true, responded_after_a1_message_id: 'wamid.AFTER', responded_after_a1_message_type: 'text', responded_after_a1_connection_id: conn.id });

    // Liste Automation 2 automatique à partir des réponses
    const r = await app.inject({ method: 'POST', url: '/imports/responders', headers: auth() });
    expect(r.json().counts).toMatchObject({ valid: 1, eligible: 1 });
  });

  it('synchronisation : pas de doublon entre webhook déjà reçu et logs, pagination', async () => {
    const m1 = { type: 'inbound_message', dedupeKey: 'sendzen:in:wamid.L1', providerMessageId: 'wamid.L1', from: '+22376000010', toPhoneNumberId: 'pn-1', toPhoneNumber: null, messageType: 'text', text: 'a', timestamp: new Date(), raw: {} } as const;
    const m2 = { ...m1, dedupeKey: 'sendzen:in:wamid.L2', providerMessageId: 'wamid.L2' };
    const m3 = { ...m1, dedupeKey: 'sendzen:in:wamid.L3', providerMessageId: 'wamid.L3' };
    await postWebhook(webhookPayload({ inbound: [{ id: 'wamid.L1', from: '+22376000010', ts: Date.now() }] }));
    await drainWebhooks(env);
    env.fake.logsPages = [{ events: [m1, m2], nextCursor: null }, { events: [m3], nextCursor: null }];
    const res = await syncMissedEvents(env.ctx, conn.id);
    expect(res).toMatchObject({ logsAvailable: true, pages: 2, fetched: 3, newEvents: 2, duplicates: 1 });
    const again = await syncMissedEvents(env.ctx, conn.id);
    expect(again).toMatchObject({ newEvents: 0, duplicates: 3 });
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM inbound_messages')).toMatchObject({ n: 3 });
  });

  it('webhook stocké mais non traité (Redis perdu) : retraité par la synchronisation', async () => {
    await postWebhook(webhookPayload({ inbound: [{ id: 'wamid.LOST', from: '+22376000011', ts: Date.now() }] }));
    env.sched.webhookJobs = []; // job perdu
    const res = await syncMissedEvents(env.ctx, conn.id);
    expect(res.reprocessed).toBe(1);
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM inbound_messages')).toMatchObject({ n: 1 });
  });
});

describe('API automatisations', () => {
  it('import → analyse → confirmation → démarrage, protégé contre le double clic', async () => {
    await seedA1Config(env);
    const content = ['+223 76 00 00 00', '+22376000000', 'pas un numéro', '', '0022376000001'].join('\n');
    const imp = await app.inject({ method: 'POST', url: '/imports', headers: auth(), payload: { automationType: 'A1', source: 'paste', content } });
    expect(imp.statusCode).toBe(200);
    expect(imp.json().counts).toMatchObject({ imported: 4, valid: 2, invalid: 1, duplicatesInList: 1, eligible: 2 });
    expect(imp.json().issues.map((i: any) => i.status)).toEqual(['DUPLICATE_IN_LIST', 'INVALID']);
    expect(env.fake.sends).toHaveLength(0); // jamais d'envoi à l'import

    const noConfirm = await app.inject({ method: 'POST', url: '/runs', headers: auth(), payload: { automationType: 'A1', importId: imp.json().importId, clientRequestId: 'click-abc-1' } });
    expect(noConfirm.statusCode).toBe(400);

    const payload = { automationType: 'A1', importId: imp.json().importId, clientRequestId: 'click-abc-1', confirm: true };
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/runs', headers: auth(), payload }),
      app.inject({ method: 'POST', url: '/runs', headers: auth(), payload }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().run.id).toBe(b.json().run.id);
  });

  it('readiness signale ce qui manque au lieu de démarrer', async () => {
    const r = await app.inject({ method: 'GET', url: '/automations/A1/readiness', headers: auth() });
    expect(r.json().ready).toBe(false);
    expect(r.json().problems.map((p: any) => p.field)).toEqual(expect.arrayContaining(['audio', 'text1', 'text2']));
  });

  it('PUT délai A2 : sauvegardé en base, 1 s–2 min', async () => {
    expect((await app.inject({ method: 'PUT', url: '/automations/A2/delay', headers: auth(), payload: { seconds: 150 } })).statusCode).toBe(400);
    const r = await app.inject({ method: 'PUT', url: '/automations/A2/delay', headers: auth(), payload: { seconds: 70 } });
    expect(r.json().delaySeconds).toBe(70);
    expect(await one(env.db, `SELECT delay_between_contacts_seconds AS d FROM automation_configs WHERE automation_type='A2'`)).toMatchObject({ d: 70 });
  });

  it('présets : sauvegarde et application sans toucher la connexion', async () => {
    const connBefore = await one(env.db, 'SELECT * FROM provider_connections');
    const p = await app.inject({ method: 'POST', url: '/presets', headers: auth(), payload: { automationType: 'A2', name: 'Automatisation lente 10 sec', payload: { delaySeconds: 10, photoCount: 3 } } });
    expect(p.statusCode).toBe(200);
    const applied = await app.inject({ method: 'POST', url: `/presets/${p.json().id}/apply`, headers: auth() });
    expect(applied.json()).toMatchObject({ delaySeconds: 10, photoCount: 3 });
    expect(await one(env.db, 'SELECT * FROM provider_connections')).toEqual(connBefore);
  });
});

describe('Médias', () => {
  it('suppression refusée si utilisé par une campagne en cours ; détachée sinon', async () => {
    const { audio } = await seedA1Config(env);
    const r1 = await app.inject({ method: 'DELETE', url: `/media/${audio.id}`, headers: auth() });
    expect(r1.statusCode).toBe(409); // utilisé dans la config
    expect(r1.json().details).toContain('Automation 1 : audio');
    const { createImport } = await import('../src/services/imports.js');
    const { createRun } = await import('../src/services/runs.js');
    const imp = await createImport(env.ctx, { automationType: 'A1', source: 'paste', content: phones(2).join('\n') });
    await createRun(env.ctx, { type: 'A1', kind: 'SEQUENCE', importId: imp.importId, clientRequestId: 'm-1' });
    const r2 = await app.inject({ method: 'DELETE', url: `/media/${audio.id}?force=true`, headers: auth() });
    expect(r2.statusCode).toBe(409); // campagne en cours
    await drainRecipients(env);
    const r3 = await app.inject({ method: 'DELETE', url: `/media/${audio.id}?force=true`, headers: auth() });
    expect(r3.statusCode).toBe(200);
    const cfgRow = await one(env.db, `SELECT audio_media_id, text1 FROM automation_configs WHERE automation_type='A1'`);
    expect(cfgRow).toMatchObject({ audio_media_id: null, text1: 'Bonjour 1' });
    // L'historique conserve le média (suppression logique)
    expect(await one(env.db, 'SELECT deleted_at FROM media_assets WHERE id=$1', [audio.id])).toMatchObject({ deleted_at: expect.any(Date) });
  });

  it('upload refusé si le stockage n’est pas configuré ; URL privée refusée (SSRF)', async () => {
    const r = await app.inject({ method: 'POST', url: '/media/url', headers: auth(), payload: { kind: 'image', url: 'http://127.0.0.1/secret.png' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toMatch(/privée|inaccessible/);
  });

  it('upload fichier validé (MIME réel, taille, dimensions)', async () => {
    // PNG 1×1 valide
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const boundary = '----x';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await app.inject({ method: 'POST', url: '/media/upload', headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ kind: 'image', mime: 'image/png', width: 1, height: 1, status: 'VALID' });
    // Un faux fichier (texte renommé .png) est refusé
    const fake = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\nhello`),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r2 = await app.inject({ method: 'POST', url: '/media/upload', headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: fake });
    expect(r2.statusCode).toBe(400);
  });
});

describe('Connexion : test réel', () => {
  it('ne déclare « connecté » qu’après vérifications ; le webhook non reçu est signalé', async () => {
    const r = await app.inject({ method: 'POST', url: `/connections/${conn.id}/test`, headers: auth(), payload: {} });
    const checks = Object.fromEntries(r.json().checks.map((c: any) => [c.key, c.status]));
    expect(checks).toMatchObject({ backend: 'ok', database: 'ok', api: 'ok', project: 'ok', waba: 'ok', number: 'ok', webhook_config: 'unavailable', webhook_reception: 'warning', send: 'skipped' });
    expect(r.json().connected).toBe(true);
  });
  it('déconnecter conserve tout l’historique et efface la clé', async () => {
    await app.inject({ method: 'POST', url: `/connections/${conn.id}/disconnect`, headers: auth() });
    const c = await one(env.db, 'SELECT status, api_key_enc FROM provider_connections WHERE id=$1', [conn.id]);
    expect(c).toMatchObject({ status: 'DISCONNECTED', api_key_enc: null });
    const logs = await many(env.db, `SELECT action FROM audit_logs WHERE action LIKE 'connection.%'`);
    expect(logs.map((l) => l.action)).toContain('connection.disconnected');
  });
});
