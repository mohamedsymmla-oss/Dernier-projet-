import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initAuthCreds } from '@whiskeysockets/baileys';
import { many, one } from '../src/db/pool.js';
import { clearAuthState, loadAuthState } from '../src/qr/auth-store.js';
import { effectiveDailyCap, localMinutes, quietHoursWait } from '../src/qr/safety.js';
import { QrSessionManager, isIgnoredJid, jidToE164 } from '../src/qr/session.js';
import * as cfg from '../src/services/automation-config.js';
import { createImport } from '../src/services/imports.js';
import { createRun, startTestRun } from '../src/services/runs.js';
import { closeDb, createTestEnv, drainA2, drainRecipients, phones, seedA1Config, seedConnection, type TestEnv } from './helpers.js';
import { FakeQrSocket, enableQr, fakeSocketFactory, seedQrConfig, seedQrConnected } from './qr-helpers.js';

let env: TestEnv;
const managers: QrSessionManager[] = [];
beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop();
});
afterAll(closeDb);

function manager(make = fakeSocketFactory(env)) {
  const m = new QrSessionManager(env.ctx, make.make, { reconnectBaseMs: 5, reconnectMaxMs: 20 });
  managers.push(m);
  return { m, ...make };
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const connectedProvider = (sock: FakeQrSocket) => ({ connectedSocket: () => sock });

/** Démarre une campagne QR sur une liste collée. */
async function startQr(type: 'A1' | 'A2', list: string[]) {
  const imp = await createImport(env.ctx, { automationType: type, source: 'paste', content: list.join('\n'), channel: 'QR' });
  return createRun(env.ctx, { type, channel: 'QR', kind: 'SEQUENCE', importId: imp.importId, clientRequestId: 'qr-' + Math.random() });
}

describe('Session QR : stockage chiffré en base (aucun fichier)', () => {
  it('aller-retour des identifiants et des clés, rien en clair', async () => {
    const { m } = manager();
    await m.start();
    const s = await one(env.db, 'SELECT id FROM qr_sessions');
    const { state, saveCreds } = await loadAuthState(env.db, env.ctx.secrets, s.id);
    state.creds.me = { id: '22371111111:3@s.whatsapp.net', name: 'Boutique' };
    await saveCreds();
    await state.keys.set({ 'pre-key': { '1': { public: Buffer.from('pub-key-bytes'), private: Buffer.from('secret-bytes') } } });
    await state.keys.set({ session: { 'abc.0': new Uint8Array([1, 2, 3]) } });

    const again = await loadAuthState(env.db, env.ctx.secrets, s.id);
    expect(again.state.creds.me?.id).toBe('22371111111:3@s.whatsapp.net');
    expect(Buffer.isBuffer(again.state.creds.noiseKey.private)).toBe(true);
    const keys = await again.state.keys.get('pre-key', ['1', '2']);
    expect(Buffer.from(keys['1']!.private).toString()).toBe('secret-bytes');
    expect(keys['2']).toBeUndefined();

    const raw = await many(env.db, 'SELECT value_enc FROM qr_auth');
    expect(raw.length).toBeGreaterThanOrEqual(3);
    for (const r of raw) {
      expect(r.value_enc).toMatch(/^v1:/);
      expect(r.value_enc).not.toContain('secret');
      expect(r.value_enc).not.toContain('Boutique');
    }
    await again.state.keys.set({ 'pre-key': { '1': null } });
    expect((await again.state.keys.get('pre-key', ['1']))['1']).toBeUndefined();
    await clearAuthState(env.db, s.id);
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM qr_auth')).toMatchObject({ n: 0 });
    expect(initAuthCreds().registered).toBe(false);
  });
});

describe('Session QR : cycle de vie', () => {
  it('QR affiché puis rafraîchi, connexion détectée après le scan', async () => {
    const { m, sockets } = manager();
    await m.start();
    const sock = sockets[0]!;
    sock.emit('connection.update', { qr: 'QR-CODE-1' });
    await tick();
    expect(await one(env.db, 'SELECT status, qr FROM qr_sessions')).toMatchObject({ status: 'WAITING_SCAN', qr: 'QR-CODE-1' });
    sock.emit('connection.update', { qr: 'QR-CODE-2' });
    await tick();
    expect(await one(env.db, 'SELECT qr FROM qr_sessions')).toMatchObject({ qr: 'QR-CODE-2' });

    sock.user = { id: '22371111111:5@s.whatsapp.net', name: 'Ma Boutique' };
    sock.emit('connection.update', { connection: 'open' });
    await tick();
    const s = await one(env.db, 'SELECT * FROM qr_sessions');
    expect(s).toMatchObject({ status: 'CONNECTED', qr: null, phone_number: '+22371111111', push_name: 'Ma Boutique' });
    expect(s.paired_at).toBeTruthy();
    const conn = await one(env.db, 'SELECT provider, status, phone_number FROM provider_connections WHERE id=$1', [s.connection_id]);
    expect(conn).toMatchObject({ provider: 'qr', status: 'CONNECTED', phone_number: '+22371111111' });
    expect(m.connectedSocket()).toBe(sock);
  });

  it('QR jamais scanné : arrêt propre après ~2 minutes, pas de boucle infinie', async () => {
    const { m, sockets } = manager();
    await m.start();
    for (let i = 1; i <= 7; i++) sockets[0]!.emit('connection.update', { qr: `QR-${i}` });
    await tick(80);
    expect(await one(env.db, 'SELECT status, desired_state, last_error FROM qr_sessions')).toMatchObject({
      status: 'DISCONNECTED',
      desired_state: 'STOPPED',
      last_error: expect.stringContaining('QR expiré'),
    });
    expect(sockets[0]!.ended).toBe(true);
  });

  it('coupure réseau : reconnexion automatique, session conservée', async () => {
    const { m, sockets } = manager();
    await m.start();
    const s = await one(env.db, 'SELECT id FROM qr_sessions');
    const { state, saveCreds } = await loadAuthState(env.db, env.ctx.secrets, s.id);
    state.creds.registered = true;
    await saveCreds();
    await m.stop();
    await m.start(); // recharge des identifiants enregistrés
    const sock = sockets.at(-1)!;
    sock.user = { id: '22371111111@s.whatsapp.net' };
    sock.emit('connection.update', { connection: 'open' });
    await tick();
    sock.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 }, message: 'Connection Closed' } } });
    await tick(80);
    expect(sockets.length).toBeGreaterThanOrEqual(3); // nouveau socket créé
    sockets.at(-1)!.emit('connection.update', { connection: 'open' });
    await tick();
    expect(await one(env.db, 'SELECT status FROM qr_sessions')).toMatchObject({ status: 'CONNECTED' });
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM qr_auth')).toMatchObject({ n: expect.any(Number) });
  });

  it('appareil délié depuis le téléphone (401) : session supprimée, campagnes en pause, alerte', async () => {
    await seedQrConfig(env);
    const { m, sockets } = manager();
    await m.start();
    sockets[0]!.user = { id: '22371111111@s.whatsapp.net' };
    sockets[0]!.emit('connection.update', { connection: 'open' });
    await tick();
    enableQr(env, m);
    await startQr('A1', phones(3));
    sockets[0]!.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await tick(80);
    expect(await one(env.db, 'SELECT status, desired_state FROM qr_sessions')).toMatchObject({ status: 'LOGGED_OUT', desired_state: 'STOPPED' });
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM qr_auth')).toMatchObject({ n: 0 });
    expect(await one(env.db, `SELECT status, pause_reason FROM automation_runs WHERE channel='QR'`)).toMatchObject({
      status: 'PAUSED',
      pause_reason: expect.stringContaining('WhatsApp QR déconnecté'),
    });
    expect((await many(env.db, 'SELECT type FROM qr_events')).map((e) => e.type)).toContain('logged_out');
  });

  it('refus de WhatsApp (403) : arrêt d’urgence de tous les envois QR', async () => {
    const { m, sockets } = manager();
    await m.start();
    sockets[0]!.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 403 } } } });
    await tick(80);
    expect(await one(env.db, 'SELECT emergency_stopped FROM qr_settings')).toMatchObject({ emergency_stopped: true });
    expect(sockets.length).toBe(1); // aucune reconnexion
  });

  it('WhatsApp injoignable (ni QR ni connexion) : arrêt propre avec message clair, pas d’attente infinie', async () => {
    const f = fakeSocketFactory(env);
    const m = new QrSessionManager(env.ctx, f.make, { reconnectBaseMs: 5, connectWatchdogMs: 30 });
    managers.push(m);
    await m.start();
    await tick(120);
    await m.idle();
    expect(await one(env.db, 'SELECT status, last_error FROM qr_sessions')).toMatchObject({
      status: 'DISCONNECTED',
      last_error: expect.stringContaining('WhatsApp injoignable'),
    });
  });

  it('un seul socket actif : une deuxième instance ne peut pas se connecter en parallèle', async () => {
    const a = manager();
    const b = manager();
    await a.m.start();
    await b.m.start();
    expect(a.sockets.length).toBe(1);
    expect(b.sockets.length).toBe(0);
    await a.m.stop();
    await b.m.start();
    expect(b.sockets.length).toBe(1);
  });

  it('déconnexion manuelle : appareil délié et session effacée', async () => {
    const { m, sockets } = manager();
    await m.start();
    await m.logout();
    expect(sockets[0]!.loggedOut).toBe(true);
    expect(await one(env.db, 'SELECT status, desired_state FROM qr_sessions')).toMatchObject({ status: 'LOGGED_OUT', desired_state: 'STOPPED' });
  });
});

describe('Messages reçus sur le canal QR', () => {
  it('groupes, statuts et diffusions ignorés ; réponse après Automation 1 QR rangée côté QR uniquement', async () => {
    await seedQrConfig(env);
    const { m, sockets } = manager();
    await m.start();
    const sock = sockets[0]!;
    sock.user = { id: '22371111111@s.whatsapp.net' };
    sock.emit('connection.update', { connection: 'open' });
    await tick();
    enableQr(env, m);
    const [p] = phones(1);
    await startQr('A1', [p!]);
    await drainA2(env);
    const jid = `${p!.slice(1)}@s.whatsapp.net`;
    const ts = Math.floor(env.clock.t / 1000) + 60;
    sock.emit('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { remoteJid: jid, id: 'IN1', fromMe: false }, message: { conversation: 'Oui merci' }, messageTimestamp: ts },
        { key: { remoteJid: '1203630@g.us', id: 'G1', fromMe: false }, message: { conversation: 'groupe' }, messageTimestamp: ts },
        { key: { remoteJid: 'status@broadcast', id: 'S1', fromMe: false }, message: { conversation: 'statut' }, messageTimestamp: ts },
        { key: { remoteJid: jid, id: 'ME1', fromMe: true }, message: { conversation: 'moi' }, messageTimestamp: ts },
      ],
    });
    await tick(80);
    const ins = await many(env.db, 'SELECT provider, provider_message_id, text FROM inbound_messages');
    expect(ins).toEqual([{ provider: 'qr', provider_message_id: 'IN1', text: 'Oui merci' }]);
    const qr = await one(env.db, 'SELECT q.* FROM qr_contact_status q JOIN contacts c ON c.id=q.contact_id WHERE c.phone_e164=$1', [p]);
    expect(qr).toMatchObject({ a1_status: 'COMPLETED', responded_after_a1: true, responded_after_a1_message_id: 'IN1' });
    const c = await one(env.db, 'SELECT a1_status, responded_after_a1 FROM contacts WHERE phone_e164=$1', [p]);
    expect(c).toMatchObject({ a1_status: 'NONE', responded_after_a1: false }); // côté fournisseur intact

    // Même message reçu deux fois : appliqué une seule fois
    sock.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: jid, id: 'IN1', fromMe: false }, message: { conversation: 'Oui merci' }, messageTimestamp: ts }] });
    await tick(50);
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM inbound_messages')).toMatchObject({ n: 1 });

    // Accusés : livré puis lu
    const outId = sock.messages()[0]!;
    const sent = await one(env.db, `SELECT provider_message_id FROM outbound_messages ORDER BY created_at LIMIT 1`);
    sock.emit('messages.update', [{ key: { remoteJid: jid, id: sent.provider_message_id, fromMe: true }, update: { status: 3 } }]);
    sock.emit('messages.update', [{ key: { remoteJid: jid, id: sent.provider_message_id, fromMe: true }, update: { status: 4 } }]);
    await tick(80);
    expect(await one(env.db, 'SELECT status FROM outbound_messages WHERE provider_message_id=$1', [sent.provider_message_id])).toMatchObject({ status: 'READ' });
    expect(outId).toBeTruthy();
  });

  it('utilitaires JID', () => {
    expect(jidToE164('22376123456:12@s.whatsapp.net')).toBe('+22376123456');
    expect(jidToE164('123@lid')).toBeNull();
    expect(isIgnoredJid('1203@g.us')).toBe(true);
    expect(isIgnoredJid('status@broadcast')).toBe(true);
    expect(isIgnoredJid('x@newsletter')).toBe(true);
    expect(isIgnoredJid('22376123456@s.whatsapp.net')).toBe(false);
  });
});

describe('Automatisations QR : mêmes fonctions, données séparées', () => {
  let sock: FakeQrSocket;
  beforeEach(async () => {
    await seedQrConnected(env);
    sock = new FakeQrSocket(() => env.clock.t);
    enableQr(env, connectedProvider(sock));
  });

  it('Automation 1 QR : audio en vrai vocal (OGG/Opus, ptt) → texte 1 → texte 2, un contact à la fois avec le délai', async () => {
    await seedQrConfig(env, { delaySeconds: 30 });
    const list = phones(3);
    await startQr('A1', list);
    await drainA2(env);
    const msgs = sock.messages();
    expect(msgs).toHaveLength(9);
    const first = msgs.slice(0, 3);
    expect(first[0]!.content).toMatchObject({ ptt: true, mimetype: 'audio/ogg; codecs=opus' });
    expect(Buffer.isBuffer(first[0]!.content!.audio)).toBe(true);
    expect((first[0]!.content!.audio as Buffer).subarray(0, 4).toString()).toBe('OggS');
    expect(first.slice(1).map((m) => m.content!.text)).toEqual(['QR texte 1', 'QR texte 2']);
    // Un contact après l'autre, avec au moins 30 s entre deux contacts
    const byJid = list.map((p) => msgs.filter((m) => m.jid === `${p.slice(1)}@s.whatsapp.net`));
    for (let i = 1; i < byJid.length; i++) {
      expect(byJid[i]![0]!.at - byJid[i - 1]!.at(-1)!.at).toBeGreaterThanOrEqual(30_000);
    }
    // Présence « enregistre un vocal » avant l'audio, « écrit » avant les textes
    const types = sock.calls.filter((c) => c.jid === `${list[0]!.slice(1)}@s.whatsapp.net`).map((c) => c.type);
    expect(types.slice(0, 3)).toEqual(['presence:recording', 'presence:paused', 'message']);
    expect(types.slice(3, 6)).toEqual(['presence:composing', 'presence:paused', 'message']);
    // Conversion faite une seule fois (cache)
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM qr_media_cache')).toMatchObject({ n: 1 });
  });

  it('sans FFmpeg : audio envoyé en audio standard (jamais présenté comme message vocal)', async () => {
    await seedQrConfig(env);
    env.ctx.ffmpegAvailable = false;
    await startQr('A1', phones(1));
    await drainA2(env);
    expect(sock.messages()[0]!.content).toMatchObject({ ptt: false, mimetype: 'audio/mpeg' });
  });

  it('Automation 2 QR : audio + photos dans l’ordre', async () => {
    await seedQrConfig(env, { photos: 3, delaySeconds: 10 });
    await startQr('A2', phones(1));
    await drainA2(env);
    const msgs = sock.messages();
    expect(msgs.map((m) => (m.content!.audio ? 'audio' : m.content!.image ? 'image' : 'text'))).toEqual(['audio', 'image', 'image', 'image']);
    expect((msgs[1]!.content!.image as { url: string }).url).toBe('https://cdn.test/qr-photo1.jpg');
  });

  it('séparation totale : anti-doublon, statuts, réglages et campagnes indépendants par canal', async () => {
    await seedConnection(env);
    await seedA1Config(env);
    await seedQrConfig(env);
    const list = phones(2);
    // Côté fournisseur : Automation 1 envoyée
    const impP = await createImport(env.ctx, { automationType: 'A1', source: 'paste', content: list.join('\n') });
    await createRun(env.ctx, { type: 'A1', kind: 'SEQUENCE', importId: impP.importId, clientRequestId: 'prov-1' });
    await drainRecipients(env);
    expect(env.fake.sends).toHaveLength(6);
    // Côté QR : les mêmes numéros restent éligibles (anti-doublon propre à chaque canal)
    const impQ = await createImport(env.ctx, { automationType: 'A1', source: 'paste', content: list.join('\n'), channel: 'QR' });
    expect(impQ.counts).toMatchObject({ eligible: 2, alreadyAutomated: 0 });
    // Les deux campagnes peuvent être actives en même temps
    const { run } = await createRun(env.ctx, { type: 'A1', channel: 'QR', kind: 'SEQUENCE', importId: impQ.importId, clientRequestId: 'qr-1' });
    expect(run.channel).toBe('QR');
    await drainA2(env);
    expect(sock.messages()).toHaveLength(6);
    expect(env.fake.sends).toHaveLength(6); // rien de plus envoyé par le fournisseur
    // Nouvelle liste QR : désormais déjà automatisés côté QR
    const again = await createImport(env.ctx, { automationType: 'A1', source: 'paste', content: list.join('\n'), channel: 'QR' });
    expect(again.counts).toMatchObject({ eligible: 0, alreadyAutomated: 2 });
    // Statuts rangés séparément
    const c = await one(env.db, 'SELECT c.a1_status, q.a1_status AS qr FROM contacts c JOIN qr_contact_status q ON q.contact_id=c.id WHERE c.phone_e164=$1', [list[0]]);
    expect(c).toMatchObject({ a1_status: 'COMPLETED', qr: 'COMPLETED' });
    // Une liste importée pour un canal ne peut pas démarrer une campagne de l'autre
    await expect(
      createRun(env.ctx, { type: 'A1', channel: 'QR', kind: 'SEQUENCE', importId: impP.importId, clientRequestId: 'mix-1' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('modifier les réglages QR ne touche jamais les réglages du fournisseur (et inversement)', async () => {
    await seedA1Config(env);
    const before = await many(env.db, `SELECT * FROM automation_configs WHERE channel='PROVIDER' ORDER BY automation_type`);
    await cfg.setText(env.db, 'text1', 'autre texte QR', 'QR');
    await cfg.setDelay(env.db, 90, 'QR', 'A1');
    await cfg.setDelay(env.db, 45, 'QR', 'A2');
    await cfg.setPhotoCount(env.db, 3, 'QR');
    expect(await many(env.db, `SELECT * FROM automation_configs WHERE channel='PROVIDER' ORDER BY automation_type`)).toEqual(before);
    const qrBefore = await many(env.db, `SELECT * FROM automation_configs WHERE channel='QR' ORDER BY automation_type`);
    await cfg.setDelay(env.db, 20);
    await cfg.setText(env.db, 'text2', 'fournisseur');
    expect(await many(env.db, `SELECT * FROM automation_configs WHERE channel='QR' ORDER BY automation_type`)).toEqual(qrBefore);
  });

  it('test sur mon numéro : séquence QR envoyée uniquement au numéro de test', async () => {
    await seedQrConfig(env);
    await env.db.query(`UPDATE app_settings SET test_phone_e164='+22376009999'`);
    await startTestRun(env.ctx, 'A1', 'qr-test-1', null, 'QR');
    await drainRecipients(env);
    expect(new Set(sock.messages().map((m) => m.jid))).toEqual(new Set(['22376009999@s.whatsapp.net']));
  });
});

describe('Protection du numéro', () => {
  let sock: FakeQrSocket;
  beforeEach(async () => {
    await seedQrConnected(env);
    sock = new FakeQrSocket(() => env.clock.t);
    enableQr(env, connectedProvider(sock));
  });

  it('plafond quotidien : le contact dont la séquence dépasserait le plafond attend le lendemain', async () => {
    await seedQrConfig(env, { delaySeconds: 5 });
    await env.db.query('UPDATE qr_settings SET daily_message_cap=7');
    const { run } = await startQr('A1', phones(4));
    await drainA2(env, { maxTicks: 6 });
    expect(sock.messages()).toHaveLength(6); // 2 contacts × 3 messages ; le 3e (→ 9) attend
    const r = await one(env.db, 'SELECT status, pause_reason FROM automation_runs WHERE id=$1', [run.id]);
    expect(r).toMatchObject({ status: 'RUNNING', pause_reason: expect.stringContaining('Plafond du jour') });
    const nextTick = [...env.sched.ticks.values()][0]!;
    expect(nextTick.due - env.clock.t).toBeGreaterThan(60 * 60_000); // reprise au prochain jour
  });

  it('montée progressive : plafond divisé par deux pendant les premiers jours', () => {
    const s = { daily_message_cap: 150, warmup_days: 7 } as never;
    const now = new Date('2026-01-10T10:00:00Z');
    expect(effectiveDailyCap(s, new Date('2026-01-08T10:00:00Z'), now)).toEqual({ cap: 75, warmup: true });
    expect(effectiveDailyCap(s, new Date('2025-12-01T10:00:00Z'), now)).toEqual({ cap: 150, warmup: false });
  });

  it('heures calmes : rien ne part la nuit, reprise automatique au matin', async () => {
    await seedQrConfig(env);
    // 22:00 à Bamako (UTC+0)
    env.clock.t = Date.parse('2026-01-01T22:00:00Z');
    await env.db.query(`UPDATE qr_settings SET quiet_hours_enabled=true, quiet_start='21:00', quiet_end='08:00', timezone='Africa/Bamako'`);
    await startQr('A1', phones(1));
    await drainA2(env, { maxTicks: 1 });
    expect(sock.messages()).toHaveLength(0);
    const due = [...env.sched.ticks.values()][0]!.due;
    expect(new Date(due).toISOString()).toBe('2026-01-02T08:00:00.000Z');
    await drainA2(env);
    expect(sock.messages()).toHaveLength(3);
    expect(quietHoursWait(new Date('2026-01-01T12:00:00Z'), { quiet_hours_enabled: true, quiet_start: '21:00', quiet_end: '08:00', timezone: 'Africa/Bamako' })).toBeNull();
    expect(localMinutes(new Date('2026-01-01T12:30:00Z'), 'Europe/Paris')).toBe(13 * 60 + 30);
  });

  it('signal de restriction à l’envoi : arrêt d’urgence, campagne en pause, plus aucun envoi', async () => {
    await seedQrConfig(env, { delaySeconds: 5 });
    const { run } = await startQr('A1', phones(3));
    sock.failNext = Object.assign(new Error('rate-overlimit'), { data: 429 });
    await drainA2(env);
    expect(sock.messages()).toHaveLength(0);
    expect(await one(env.db, 'SELECT emergency_stopped, emergency_reason FROM qr_settings')).toMatchObject({
      emergency_stopped: true,
      emergency_reason: expect.stringContaining('limite de débit'),
    });
    const r = await one(env.db, 'SELECT status, pause_reason FROM automation_runs WHERE id=$1', [run.id]);
    expect(r).toMatchObject({ status: 'PAUSED', pause_reason: expect.stringContaining("Arrêt d'urgence") });
    // Tant que l'arrêt n'est pas levé manuellement, rien ne repart
    await env.db.query(`UPDATE automation_runs SET status='RUNNING' WHERE id=$1`, [run.id]);
    const { dispatchRun } = await import('../src/services/runs.js');
    await dispatchRun(env.ctx, await one(env.db, 'SELECT * FROM automation_runs WHERE id=$1', [run.id]));
    await drainA2(env);
    expect(sock.messages()).toHaveLength(0);
  });

  it('WhatsApp QR déconnecté : la campagne se met en pause au lieu d’échouer', async () => {
    await seedQrConfig(env);
    enableQr(env, { connectedSocket: () => null });
    const { run } = await startQr('A1', phones(2));
    await env.db.query(`UPDATE qr_sessions SET status='CONNECTED'`);
    await drainA2(env);
    const r = await one(env.db, 'SELECT status, pause_reason FROM automation_runs WHERE id=$1', [run.id]);
    expect(r).toMatchObject({ status: 'PAUSED', pause_reason: expect.stringContaining('WhatsApp QR déconnecté') });
    const recs = await many(env.db, 'SELECT status FROM automation_recipients WHERE run_id=$1', [run.id]);
    expect(recs.every((x) => x.status === 'PENDING')).toBe(true); // rien de perdu, rien compté en échec
  });
});
