import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { one } from '../src/db/pool.js';
import { closeDb, createTestEnv, seedConnection, type TestEnv } from './helpers.js';
import { seedQrConnected } from './qr-helpers.js';

let env: TestEnv;
let app: Awaited<ReturnType<typeof buildApp>>;
let token: string;
const controls: string[] = [];

beforeEach(async () => {
  env = await createTestEnv();
  controls.length = 0;
  env.ctx.qrControl = async (a) => void controls.push(a);
  await seedConnection(env);
  await createUser(env.ctx, 'moi@exemple.com', 'MotDePasseTresLong1');
  app = await buildApp(env.ctx);
  token = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'moi@exemple.com', password: 'MotDePasseTresLong1' } })).json().token;
});
afterAll(async () => {
  await app?.close();
  await closeDb();
});
const auth = () => ({ authorization: `Bearer ${token}` });

describe('API WhatsApp QR', () => {
  it('routes protégées par l’authentification', async () => {
    expect((await app.inject({ method: 'GET', url: '/qr/session' })).statusCode).toBe(401);
  });

  it('démarrer la connexion : demande envoyée au worker, statut « connexion en cours »', async () => {
    const r = await app.inject({ method: 'POST', url: '/qr/session/start', headers: auth() });
    expect(r.json()).toEqual({ status: 'CONNECTING' });
    expect(controls).toEqual(['start']);
    const s = await app.inject({ method: 'GET', url: '/qr/session', headers: auth() });
    expect(s.json()).toMatchObject({ status: 'CONNECTING', desiredState: 'RUNNING', qr: null, safety: { dailyCap: 150, emergencyStopped: false } });
  });

  it('QR renvoyé seulement pendant l’attente de scan', async () => {
    await app.inject({ method: 'POST', url: '/qr/session/start', headers: auth() });
    await env.db.query(`UPDATE qr_sessions SET status='WAITING_SCAN', qr='2@abc,def'`);
    expect((await app.inject({ method: 'GET', url: '/qr/session', headers: auth() })).json().qr).toBe('2@abc,def');
  });

  it('la connexion QR n’apparaît jamais parmi les connexions du fournisseur', async () => {
    await seedQrConnected(env);
    const list = (await app.inject({ method: 'GET', url: '/connections', headers: auth() })).json();
    expect(list.map((c: { provider: string }) => c.provider)).toEqual(['sendzen']);
  });

  it('même numéro que le fournisseur : signalé', async () => {
    await seedQrConnected(env, '+22370000000');
    expect((await app.inject({ method: 'GET', url: '/qr/session', headers: auth() })).json().sameNumberAsProvider).toBe(true);
  });

  it('réglages de protection : validation et enregistrement', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/qr/settings', headers: auth(), payload: { timezone: 'Mars/Olympus' } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'PUT',
      url: '/qr/settings',
      headers: auth(),
      payload: { dailyMessageCap: 40, quietStart: '20:30', quietEnd: '09:00', timezone: 'Europe/Paris', warmupDays: 10 },
    });
    expect(ok.json()).toMatchObject({ dailyMessageCap: 40, quietStart: '20:30', quietEnd: '09:00', timezone: 'Europe/Paris', warmupDays: 10 });
  });

  it('arrêt d’urgence : levée manuelle tracée', async () => {
    await env.db.query(`UPDATE qr_settings SET emergency_stopped=true, emergency_reason='test'`);
    const r = await app.inject({ method: 'POST', url: '/qr/emergency/reset', headers: auth() });
    expect(r.json().emergencyStopped).toBe(false);
    expect(await one(env.db, `SELECT count(*)::int AS n FROM audit_logs WHERE action='qr.emergency_reset'`)).toMatchObject({ n: 1 });
  });

  it('réglages d’automatisation par canal : ?channel=QR ne touche pas au fournisseur', async () => {
    const qr = await app.inject({ method: 'PUT', url: '/automations/A1/texts/text1?channel=QR', headers: auth(), payload: { value: 'Bonjour QR' } });
    expect(qr.json()).toMatchObject({ channel: 'QR', text1: 'Bonjour QR', delaySeconds: 60 });
    const prov = await app.inject({ method: 'GET', url: '/automations/A1/config', headers: auth() });
    expect(prov.json()).toMatchObject({ channel: 'PROVIDER', text1: '' });
    expect(prov.json().delaySeconds).toBeUndefined();
    // Minuteur Automation 1 : seulement côté QR
    expect((await app.inject({ method: 'PUT', url: '/automations/A1/delay?channel=QR', headers: auth(), payload: { seconds: 45 } })).json().delaySeconds).toBe(45);
    expect((await app.inject({ method: 'PUT', url: '/automations/A1/delay', headers: auth(), payload: { seconds: 45 } })).statusCode).toBe(400);
  });

  it('démarrage d’une campagne QR refusé tant que WhatsApp QR n’est pas connecté', async () => {
    const r = await app.inject({ method: 'GET', url: '/automations/A1/readiness?channel=QR', headers: auth() });
    expect(r.json().problems.map((p: { field: string }) => p.field)).toContain('connection');
    expect(r.json().problems[0].message).toContain('QR');
  });
});
