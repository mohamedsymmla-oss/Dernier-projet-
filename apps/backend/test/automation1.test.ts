import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { permanentError, rateLimitError, transientError } from '@wa/provider-connectors';
import { many, one } from '../src/db/pool.js';
import { processRecipient } from '../src/services/engine.js';
import { createImport } from '../src/services/imports.js';
import { createRun, pauseRun, resumeRun, retryRecipients, stopRun } from '../src/services/runs.js';
import { closeDb, createTestEnv, drainRecipients, phones, seedA1Config, seedConnection, type TestEnv } from './helpers.js';

let env: TestEnv;

async function startA1(list: string[], clientRequestId = 'req-' + Math.random()) {
  const imp = await createImport(env.ctx, { automationType: 'A1', source: 'paste', content: list.join('\n') });
  return createRun(env.ctx, { type: 'A1', kind: 'SEQUENCE', importId: imp.importId, clientRequestId });
}

beforeEach(async () => {
  env = await createTestEnv();
  await seedConnection(env);
  await seedA1Config(env);
});
afterAll(closeDb);

describe('Automation 1 — séquence et ordre', () => {
  it('envoie audio → texte 1 → texte 2 dans cet ordre strict pour chaque contact', async () => {
    const list = phones(3);
    const { run } = await startA1(list);
    expect(run.total).toBe(3);
    await drainRecipients(env);
    for (const p of list) {
      const kinds = env.fake.sends.filter((s) => s.to === p).map((s) => (s.message.kind === 'text' ? s.message.body : s.message.kind));
      expect(kinds).toEqual(['audio', 'Bonjour 1', 'Texte 2']);
    }
    const r = await one(env.db, 'SELECT status FROM automation_runs WHERE id=$1', [run.id]);
    expect(r.status).toBe('COMPLETED');
    const c = await one(env.db, 'SELECT a1_status, a1_first_sent_at, a1_completed_at FROM contacts WHERE phone_e164=$1', [list[0]]);
    expect(c.a1_status).toBe('COMPLETED');
    expect(c.a1_first_sent_at).toBeTruthy();
  });

  it("statuts : l'acceptation API n'est pas « lu »", async () => {
    await startA1(phones(1));
    await drainRecipients(env);
    const msgs = await many(env.db, 'SELECT status, read_at, delivered_at FROM outbound_messages');
    expect(msgs).toHaveLength(3);
    for (const m of msgs) {
      expect(m.status).toBe('ACCEPTED');
      expect(m.read_at).toBeNull();
      expect(m.delivered_at).toBeNull();
    }
  });
});

describe('Automation 1 — anti-doublon et idempotence', () => {
  it('traiter deux fois le même destinataire n’envoie rien de plus', async () => {
    const { run } = await startA1(phones(1));
    const rec = await one(env.db, 'SELECT id FROM automation_recipients WHERE run_id=$1', [run.id]);
    await drainRecipients(env);
    await processRecipient(env.ctx, rec.id);
    await processRecipient(env.ctx, rec.id);
    expect(env.fake.sends).toHaveLength(3);
  });

  it('double clic : même clientRequestId → une seule campagne', async () => {
    const imp = await createImport(env.ctx, { automationType: 'A1', source: 'paste', content: phones(2).join('\n') });
    const [a, b] = await Promise.all([
      createRun(env.ctx, { type: 'A1', kind: 'SEQUENCE', importId: imp.importId, clientRequestId: 'same-click-123' }),
      createRun(env.ctx, { type: 'A1', kind: 'SEQUENCE', importId: imp.importId, clientRequestId: 'same-click-123' }),
    ]);
    expect(a.run.id).toBe(b.run.id);
    const n = await one(env.db, 'SELECT count(*)::int AS n FROM automation_runs');
    expect(n.n).toBe(1);
  });

  it('refuse une deuxième campagne A1 active', async () => {
    await startA1(phones(2));
    await expect(startA1(phones(2, 10))).rejects.toMatchObject({ statusCode: 409 });
  });

  it('un contact déjà automatisé est exclu d’une nouvelle liste (analyse + campagne)', async () => {
    await startA1(phones(3));
    await drainRecipients(env);
    const imp = await createImport(env.ctx, {
      automationType: 'A1',
      source: 'paste',
      content: [...phones(3), '+22376009999', '76-00-99-99', 'abc', ''].join('\n'),
    });
    expect(imp.counts).toMatchObject({ valid: 4, invalid: 1, duplicatesInList: 1, alreadyAutomated: 3, eligible: 1, emptyLines: 1 });
    const { run } = await createRun(env.ctx, { type: 'A1', kind: 'SEQUENCE', importId: imp.importId, clientRequestId: 'x2' });
    expect(run.total).toBe(1);
    await drainRecipients(env);
    expect(env.fake.sends.filter((s) => s.to === phones(1)[0])).toHaveLength(3); // pas de renvoi
  });

  it('refuse une liste sans aucun destinataire éligible', async () => {
    await startA1(phones(1));
    await drainRecipients(env);
    await expect(startA1(phones(1))).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('Automation 1 — reprise et erreurs', () => {
  it('reprise partielle : seul texte 2 est renvoyé après une erreur temporaire épuisée', async () => {
    // audio ok, texte 1 ok, puis texte 2 échoue 4 fois (max tentatives)
    env.fake.failures = [null as any, null as any, transientError(), transientError(), transientError(), transientError()].map((f) =>
      f ? f : () => null,
    );
    const { run } = await startA1(phones(1));
    await drainRecipients(env);
    const rec = await one(env.db, 'SELECT * FROM automation_recipients WHERE run_id=$1', [run.id]);
    expect(rec.status).toBe('FAILED');
    const steps = await many(env.db, 'SELECT label, status, attempts FROM automation_steps WHERE recipient_id=$1 ORDER BY step_index', [rec.id]);
    expect(steps.map((s) => s.status)).toEqual(['ACCEPTED', 'ACCEPTED', 'FAILED']);
    expect(steps[2]!.attempts).toBe(4);
    expect(env.fake.sends).toHaveLength(2);

    await retryRecipients(env.ctx, { runId: run.id });
    await drainRecipients(env);
    const kinds = env.fake.sends.map((s) => (s.message.kind === 'text' ? s.message.body : s.message.kind));
    expect(kinds).toEqual(['audio', 'Bonjour 1', 'Texte 2']); // audio et texte 1 jamais renvoyés
    const again = await one(env.db, 'SELECT status FROM automation_recipients WHERE id=$1', [rec.id]);
    expect(again.status).toBe('COMPLETED');
  });

  it('retry avec backoff exponentiel sur erreurs temporaires puis succès', async () => {
    env.fake.failures = [transientError(), transientError()];
    await startA1(phones(1));
    await drainRecipients(env);
    expect(env.fake.sends).toHaveLength(3);
    const audio = await one(env.db, `SELECT attempts, status FROM automation_steps WHERE step_index=0`);
    expect(audio).toMatchObject({ attempts: 3, status: 'ACCEPTED' });
    // Attentes croissantes (2 s puis 4 s, + gigue ≤ 20 %)
    const backoffs = env.clock.sleeps.filter((s) => s !== 1000);
    expect(backoffs[0]).toBeGreaterThanOrEqual(2000);
    expect(backoffs[0]).toBeLessThanOrEqual(2400);
    expect(backoffs[1]).toBeGreaterThanOrEqual(4000);
    expect(backoffs[1]).toBeLessThanOrEqual(4800);
    const failedAttempts = await one(env.db, `SELECT count(*)::int AS n FROM outbound_messages WHERE status='FAILED'`);
    expect(failedAttempts.n).toBe(2);
  });

  it('429 : respecte Retry-After et bloque le débit de la connexion', async () => {
    env.fake.failures = [rateLimitError(7000)];
    await startA1(phones(1));
    await drainRecipients(env);
    expect(env.limiter.blocks[0]!.ms).toBe(7000);
    expect(env.clock.sleeps.some((s) => s >= 7000)).toBe(true);
    expect(env.fake.sends).toHaveLength(3);
  });

  it('erreur définitive : pas de boucle, raison enregistrée', async () => {
    env.fake.failures = [permanentError('INVALID_RECIPIENT')];
    const { run } = await startA1(phones(2));
    await drainRecipients(env);
    const recs = await many(env.db, 'SELECT status, last_error FROM automation_recipients WHERE run_id=$1 ORDER BY position', [run.id]);
    expect(recs[0]!.status).toBe('FAILED');
    expect(recs[0]!.last_error).toContain('INVALID_RECIPIENT');
    expect(recs[1]!.status).toBe('COMPLETED');
    const attempts = await one(env.db, 'SELECT max(attempts)::int AS m FROM automation_steps WHERE status=$1', ['FAILED']);
    expect(attempts.m).toBe(1);
    // Une erreur définitive n'est pas relancée par « réessayer »
    const r = await retryRecipients(env.ctx, { runId: run.id });
    expect(r.retried).toBe(0);
  });

  it('authentification refusée : campagne mise en pause, rien de perdu', async () => {
    env.fake.failures = [permanentError('AUTH')];
    const { run } = await startA1(phones(3));
    await drainRecipients(env);
    const r = await one(env.db, 'SELECT status, pause_reason FROM automation_runs WHERE id=$1', [run.id]);
    expect(r.status).toBe('PAUSED');
    expect(r.pause_reason).toContain('Authentification');
    expect(env.fake.sends).toHaveLength(0);
    await resumeRun(env.ctx, run.id);
    await drainRecipients(env);
    expect(env.fake.sends).toHaveLength(9);
    const done = await one(env.db, 'SELECT status FROM automation_runs WHERE id=$1', [run.id]);
    expect(done.status).toBe('COMPLETED');
  });

  it('crash pendant un envoi (étape SUBMITTING) : pas de renvoi automatique, vérification requise', async () => {
    const { run } = await startA1(phones(1));
    const rec = await one(env.db, 'SELECT id FROM automation_recipients WHERE run_id=$1', [run.id]);
    // Simule : audio accepté, texte 1 en cours d'envoi au moment du crash, bail expiré
    await processRecipient(env.ctx, rec.id); // envoie tout
    await env.db.query(`UPDATE automation_steps SET status='SUBMITTING' WHERE recipient_id=$1 AND step_index=1`, [rec.id]);
    await env.db.query(`UPDATE automation_steps SET status='PENDING' WHERE recipient_id=$1 AND step_index=2`, [rec.id]);
    await env.db.query(`UPDATE automation_recipients SET status='IN_PROGRESS', lease_until=now() - interval '1 second' WHERE id=$1`, [rec.id]);
    await env.db.query(`UPDATE automation_runs SET status='RUNNING' WHERE id=$1`, [run.id]);
    const before = env.fake.sends.length;
    const res = await processRecipient(env.ctx, rec.id);
    expect(res.outcome).toBe('blocked');
    expect(env.fake.sends.length).toBe(before);
    const recNow = await one(env.db, 'SELECT status FROM automation_recipients WHERE id=$1', [rec.id]);
    expect(recNow.status).toBe('NEEDS_REVIEW');
    const step = await one(env.db, 'SELECT status FROM automation_steps WHERE recipient_id=$1 AND step_index=1', [rec.id]);
    expect(step.status).toBe('UNCERTAIN');
  });

  it('un destinataire en cours chez un autre worker (bail actif) n’est pas traité deux fois', async () => {
    const { run } = await startA1(phones(1));
    const rec = await one(env.db, 'SELECT id FROM automation_recipients WHERE run_id=$1', [run.id]);
    await env.db.query(`UPDATE automation_recipients SET status='IN_PROGRESS', lease_until=now() + interval '1 minute' WHERE id=$1`, [rec.id]);
    const res = await processRecipient(env.ctx, rec.id);
    expect(res.outcome).toBe('skipped');
    expect(env.fake.sends).toHaveLength(0);
  });

  it('pause puis reprise : aucun contact perdu ni doublé', async () => {
    const { run } = await startA1(phones(4));
    const first = env.sched.recipientJobs.shift()!;
    await processRecipient(env.ctx, first.recipientId);
    await pauseRun(env.ctx, run.id);
    await drainRecipients(env); // jobs ignorés pendant la pause
    expect(env.fake.sends).toHaveLength(3);
    await resumeRun(env.ctx, run.id);
    await drainRecipients(env);
    expect(env.fake.sends).toHaveLength(12);
    expect(new Set(env.fake.sends.map((s) => s.to)).size).toBe(4);
  });

  it('arrêt : annule les contacts restants sans effacer l’historique ; ils restent éligibles plus tard', async () => {
    const { run } = await startA1(phones(3));
    const first = env.sched.recipientJobs.shift()!;
    await processRecipient(env.ctx, first.recipientId);
    await stopRun(env.ctx, run.id);
    await drainRecipients(env);
    const recs = await many(env.db, 'SELECT status FROM automation_recipients WHERE run_id=$1 ORDER BY position', [run.id]);
    expect(recs.map((r) => r.status)).toEqual(['COMPLETED', 'CANCELLED', 'CANCELLED']);
    const { run: run2 } = await startA1(phones(3));
    expect(run2.total).toBe(2);
    await drainRecipients(env);
    expect(env.fake.sends).toHaveLength(9);
  });
});

describe('Conformité : fenêtre de 24 h', () => {
  it('dernier message client > 24 h : « Modèle WhatsApp requis », rien envoyé', async () => {
    const [p] = phones(1);
    await env.db.query(`INSERT INTO contacts (phone_e164, last_inbound_at) VALUES ($1, $2)`, [p, new Date(env.clock.t - 25 * 3600_000)]);
    const { run } = await startA1([p!]);
    await drainRecipients(env);
    expect(env.fake.sends).toHaveLength(0);
    const rec = await one(env.db, 'SELECT status FROM automation_recipients WHERE run_id=$1', [run.id]);
    expect(rec.status).toBe('TEMPLATE_REQUIRED');
    const c = await one(env.db, 'SELECT a1_status FROM contacts WHERE phone_e164=$1', [p]);
    expect(c.a1_status).toBe('TEMPLATE_REQUIRED');
  });

  it('dernier message client < 24 h : envoi autorisé', async () => {
    const [p] = phones(1);
    await env.db.query(`INSERT INTO contacts (phone_e164, last_inbound_at) VALUES ($1, $2)`, [p, new Date(env.clock.t - 3600_000)]);
    await startA1([p!]);
    await drainRecipients(env);
    expect(env.fake.sends).toHaveLength(3);
  });

  it('politique stricte : fenêtre inconnue → modèle requis', async () => {
    await env.db.query(`UPDATE automation_configs SET window_policy='REQUIRE_KNOWN' WHERE automation_type='A1'`);
    await startA1(phones(1));
    await drainRecipients(env);
    expect(env.fake.sends).toHaveLength(0);
  });

  it('le fournisseur refuse (131047) : marqué modèle requis, pas de contournement', async () => {
    env.fake.failures = [permanentError('WINDOW_CLOSED')];
    const { run } = await startA1(phones(1));
    await drainRecipients(env);
    const rec = await one(env.db, 'SELECT status FROM automation_recipients WHERE run_id=$1', [run.id]);
    expect(rec.status).toBe('TEMPLATE_REQUIRED');
    expect(env.fake.sends).toHaveLength(0);
  });
});

describe('Mode TEST et changement de connexion', () => {
  it('une campagne de test ne marque pas les contacts comme automatisés', async () => {
    await env.db.query(`UPDATE app_settings SET test_phone_e164='+22376001234'`);
    const { startTestRun } = await import('../src/services/runs.js');
    await startTestRun(env.ctx, 'A1', 'test-click-1');
    await drainRecipients(env);
    expect(env.fake.sends.map((s) => s.to)).toEqual(['+22376001234', '+22376001234', '+22376001234']);
    const c = await one(env.db, 'SELECT a1_status FROM contacts WHERE phone_e164=$1', ['+22376001234']);
    expect(c.a1_status).toBe('NONE');
    const imp = await createImport(env.ctx, { automationType: 'A1', source: 'paste', content: '+22376001234' });
    expect(imp.counts.eligible).toBe(1);
  });

  it('reconnexion / nouvelle connexion : l’historique et l’anti-doublon sont conservés', async () => {
    await startA1(phones(2));
    await drainRecipients(env);
    await env.db.query(`UPDATE provider_connections SET status='DISCONNECTED', api_key_enc=NULL`);
    await seedConnection(env); // nouvelle connexion au même numéro
    const imp = await createImport(env.ctx, { automationType: 'A1', source: 'paste', content: phones(2).join('\n') });
    expect(imp.counts.alreadyAutomated).toBe(2);
    expect(imp.counts.eligible).toBe(0);
    const hist = await one(env.db, 'SELECT count(*)::int AS n FROM outbound_messages');
    expect(hist.n).toBe(6);
  });

  it('les données TEST et PRODUCTION ne se mélangent pas', async () => {
    await env.db.query(`UPDATE provider_connections SET mode='TEST'`);
    await startA1(phones(1));
    await drainRecipients(env);
    const c = await one(env.db, 'SELECT a1_status FROM contacts WHERE phone_e164=$1', [phones(1)[0]]);
    expect(c.a1_status).toBe('NONE'); // statut production intact
    await env.db.query(`UPDATE provider_connections SET mode='PRODUCTION'`);
    const imp = await createImport(env.ctx, { automationType: 'A1', source: 'paste', content: phones(1).join('\n') });
    expect(imp.counts.eligible).toBe(1);
  });
});
