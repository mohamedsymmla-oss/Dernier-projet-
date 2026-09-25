import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { transientError } from '@wa/provider-connectors';
import { many, one } from '../src/db/pool.js';
import * as cfg from '../src/services/automation-config.js';
import { a2Tick } from '../src/services/engine.js';
import { createImport } from '../src/services/imports.js';
import { createRun, getRunProgress, pauseRun, recoverRuns, resumeRun, stopRun } from '../src/services/runs.js';
import { closeDb, createTestEnv, drainA2, phones, seedA2Config, seedConnection, type TestEnv } from './helpers.js';

let env: TestEnv;

async function startA2(list: string[]) {
  const imp = await createImport(env.ctx, { automationType: 'A2', source: 'paste', content: list.join('\n') });
  return createRun(env.ctx, { type: 'A2', kind: 'SEQUENCE', importId: imp.importId, clientRequestId: 'a2-' + Math.random() });
}

/** Regroupe les envois par contact, dans l'ordre de traitement. */
function perContact() {
  const order: string[] = [];
  const map = new Map<string, number[]>();
  for (const s of env.fake.sends) {
    if (!map.has(s.to)) {
      map.set(s.to, []);
      order.push(s.to);
    }
    map.get(s.to)!.push(s.at);
  }
  return order.map((to) => ({ to, first: map.get(to)![0]!, last: map.get(to)!.at(-1)!, count: map.get(to)!.length }));
}

beforeEach(async () => {
  env = await createTestEnv();
  await seedConnection(env);
});
afterAll(closeDb);

describe('Automation 2 — séquence audio + photos', () => {
  it('audio puis N photos dans l’ordre choisi, un contact à la fois', async () => {
    const { imgs } = await seedA2Config(env, 7, 10);
    await startA2(phones(3));
    await drainA2(env);
    const c = perContact();
    expect(c.map((x) => x.count)).toEqual([8, 8, 8]);
    const first = env.fake.sends.filter((s) => s.to === phones(1)[0]);
    expect(first[0]!.message.kind).toBe('audio');
    expect(first.slice(1).map((s) => (s.message as any).media.link)).toEqual(imgs.map((m) => `https://cdn.test/${m.name}`));
    // Jamais deux contacts entrelacés
    for (let i = 1; i < c.length; i++) expect(c[i]!.first).toBeGreaterThan(c[i - 1]!.last);
  });

  it('10 photos possibles', async () => {
    await seedA2Config(env, 10, 5);
    await startA2(phones(1));
    await drainA2(env);
    expect(env.fake.sends).toHaveLength(11);
  });

  it('nombre de photos inférieur aux photos disponibles : seules les premières sont envoyées', async () => {
    await seedA2Config(env, 5, 5);
    await cfg.setPhotoCount(env.db, 2);
    await startA2(phones(1));
    await drainA2(env);
    expect(env.fake.sends.map((s) => s.message.kind)).toEqual(['audio', 'image', 'image']);
  });
});

describe('Automation 2 — minuteur réel respecté par le worker', () => {
  for (const delay of [1, 5, 10, 20, 60, 120]) {
    it(`délai ${delay} s : le contact suivant ne démarre jamais avant ${delay} s après la fin du précédent`, async () => {
      await seedA2Config(env, 2, delay);
      await startA2(phones(4));
      await drainA2(env);
      const c = perContact();
      expect(c).toHaveLength(4);
      for (let i = 1; i < c.length; i++) {
        const gap = c[i]!.first - c[i - 1]!.last;
        expect(gap).toBeGreaterThanOrEqual(delay * 1000);
        expect(gap).toBeLessThan(delay * 1000 + 1000); // et pas d'attente injustifiée
      }
    });
  }

  it('un tick déclenché trop tôt (job en avance, horloge décalée) ne démarre pas le contact suivant', async () => {
    await seedA2Config(env, 1, 10);
    const { run } = await startA2(phones(2));
    // Premier contact
    const [k1, t1] = [...env.sched.ticks.entries()][0]!;
    env.sched.ticks.delete(k1);
    await a2Tick(env.ctx, t1.runId, t1.seq);
    expect(env.fake.sends).toHaveLength(2);
    // On force un tick immédiat (comme un job en double)
    const [k2, t2] = [...env.sched.ticks.entries()][0]!;
    env.sched.ticks.delete(k2);
    env.clock.t += 3000; // seulement 3 s
    const res = await a2Tick(env.ctx, run.id, t2.seq);
    expect(res).toBe('waiting');
    expect(env.fake.sends).toHaveLength(2);
    // Un job périmé (ancien numéro de séquence) est ignoré
    expect(await a2Tick(env.ctx, run.id, t1.seq)).toBe('stale');
  });

  it('modification du délai pendant la campagne : appliquée au contact suivant', async () => {
    await seedA2Config(env, 1, 10);
    await startA2(phones(3));
    await drainA2(env, { maxTicks: 1 }); // contact 1 envoyé
    await cfg.setDelay(env.db, 60);
    // simuler la reprogrammation déclenchée par la route PUT /automations/A2/delay
    const run = await one(env.db, `SELECT * FROM automation_runs WHERE automation_type='A2'`);
    const { dispatchRun } = await import('../src/services/runs.js');
    await dispatchRun(env.ctx, run);
    await drainA2(env);
    const c = perContact();
    expect(c[1]!.first - c[0]!.last).toBeGreaterThanOrEqual(60_000);
    expect(c[2]!.first - c[1]!.last).toBeGreaterThanOrEqual(60_000);
  });

  it('un échec de contact n’empêche pas le suivant et le délai reste appliqué', async () => {
    await seedA2Config(env, 1, 20);
    env.fake.failures = Array.from({ length: 4 }, () => transientError());
    const { run } = await startA2(phones(2));
    await drainA2(env);
    const recs = await many(env.db, 'SELECT status FROM automation_recipients WHERE run_id=$1 ORDER BY position', [run.id]);
    expect(recs.map((r) => r.status)).toEqual(['FAILED', 'COMPLETED']);
  });
});

describe('Automation 2 — pause / reprise / arrêt / redémarrage', () => {
  it('pause : ne perd pas la position ; reprise : continue exactement où elle s’était arrêtée', async () => {
    await seedA2Config(env, 1, 30);
    const { run } = await startA2(phones(5));
    await drainA2(env, { maxTicks: 3 }); // contacts 1, (attente), 2
    const sentBefore = perContact().length;
    await pauseRun(env.ctx, run.id);
    env.clock.t += 600_000; // 10 minutes de pause
    await drainA2(env); // ticks ignorés pendant la pause
    expect(perContact().length).toBe(sentBefore);
    await resumeRun(env.ctx, run.id);
    await drainA2(env);
    const c = perContact();
    expect(c.map((x) => x.to)).toEqual(phones(5)); // ordre conservé, aucun doublon
    expect(env.fake.sends).toHaveLength(10);
    const p = await getRunProgress(env.ctx, run.id);
    expect(p.counts).toMatchObject({ total: 5, completed: 5, remaining: 0 });
  });

  it('redémarrage du serveur : reprend au bon contact, sans recommencer au n°1 ni raccourcir le délai', async () => {
    await seedA2Config(env, 2, 60);
    const { run } = await startA2(phones(30));
    // 26 contacts terminés
    await drainA2(env, { until: () => perContact().length >= 26 && env.sched.ticks.size > 0 && [...env.sched.ticks.values()][0]!.due > env.clock.t });
    expect(perContact().length).toBe(26);
    // Crash : Redis perdu (plus aucun job), 10 s après la fin du contact 26
    env.sched.ticks.clear();
    env.clock.t += 10_000;
    const lastFinished = perContact()[25]!.last;
    await recoverRuns(env.ctx); // reconstruit depuis PostgreSQL
    await drainA2(env);
    const c = perContact();
    expect(c).toHaveLength(30);
    expect(c.map((x) => x.to)).toEqual(phones(30)); // pas de recommencement
    expect(env.fake.sends).toHaveLength(90);
    expect(c[26]!.first - lastFinished).toBeGreaterThanOrEqual(60_000);
    const r = await one(env.db, 'SELECT status FROM automation_runs WHERE id=$1', [run.id]);
    expect(r.status).toBe('COMPLETED');
  });

  it('crash au milieu d’un contact : seules les photos manquantes sont envoyées', async () => {
    await seedA2Config(env, 3, 10);
    const { run } = await startA2(phones(2));
    await drainA2(env, { maxTicks: 1 });
    const rec = await one(env.db, 'SELECT id FROM automation_recipients WHERE run_id=$1 AND position=0', [run.id]);
    // Simule un crash après audio + photo 1
    await env.db.query(`UPDATE automation_steps SET status='PENDING' WHERE recipient_id=$1 AND step_index >= 2`, [rec.id]);
    await env.db.query(`UPDATE automation_recipients SET status='IN_PROGRESS', lease_until=now() - interval '1 s' WHERE id=$1`, [rec.id]);
    await env.db.query(`UPDATE automation_runs SET last_contact_finished_at=NULL, status='RUNNING', completed_at=NULL WHERE id=$1`, [run.id]);
    env.sched.ticks.clear();
    const before = env.fake.sends.length;
    await recoverRuns(env.ctx);
    await drainA2(env, { maxTicks: 1 });
    const resent = env.fake.sends.slice(before).filter((s) => s.to === phones(1)[0]);
    expect(resent).toHaveLength(2); // photos 2 et 3 seulement
  });

  it('arrêt propre : historique conservé, contacts restants annulés', async () => {
    await seedA2Config(env, 1, 30);
    const { run } = await startA2(phones(4));
    await drainA2(env, { maxTicks: 1 });
    await stopRun(env.ctx, run.id);
    await drainA2(env);
    const recs = await many(env.db, 'SELECT status FROM automation_recipients WHERE run_id=$1 ORDER BY position', [run.id]);
    expect(recs.map((r) => r.status)).toEqual(['COMPLETED', 'CANCELLED', 'CANCELLED', 'CANCELLED']);
    expect(await one(env.db, 'SELECT count(*)::int AS n FROM outbound_messages')).toMatchObject({ n: 2 });
  });

  it('progression : prochain contact et prochain envoi', async () => {
    await seedA2Config(env, 1, 60);
    const { run } = await startA2(phones(3));
    await drainA2(env, { maxTicks: 1 });
    env.clock.t += 18_000;
    const p = await getRunProgress(env.ctx, run.id);
    expect(p.counts).toMatchObject({ total: 3, completed: 1, remaining: 2, failed: 0 });
    expect(p.a2).toMatchObject({ delaySeconds: 60, nextContactPhone: phones(3)[1] });
    expect(new Date(p.a2!.nextSendAt as string).getTime() - env.clock.t).toBe(42_000);
  });
});

describe('Isolation des réglages', () => {
  it('changer le délai A2 de 10 s à 60 s ne modifie rien d’autre', async () => {
    const { audio, imgs } = await seedA2Config(env, 7, 10);
    const a1audio = await one(env.db, `INSERT INTO media_assets (kind, source, name, external_url, status) VALUES ('audio','url','a1.ogg','https://x/a1.ogg','VALID') RETURNING id`);
    await env.db.query(`UPDATE automation_configs SET audio_media_id=$1, text1='T1', text2='T2' WHERE automation_type='A1'`, [a1audio.id]);
    await createImport(env.ctx, { automationType: 'A2', source: 'paste', content: phones(5).join('\n') });

    const snapshot = async () => ({
      a1: await one(env.db, `SELECT * FROM automation_configs WHERE automation_type='A1'`),
      a2: await one(env.db, `SELECT audio_media_id, photo_media_ids, photo_count, window_policy, content_version FROM automation_configs WHERE automation_type='A2'`),
      conn: await one(env.db, `SELECT * FROM provider_connections`),
      contacts: await many(env.db, `SELECT * FROM contacts ORDER BY phone_e164`),
      media: await many(env.db, `SELECT * FROM media_assets ORDER BY id`),
      settings: await one(env.db, `SELECT * FROM app_settings`),
    });
    const before = await snapshot();
    await cfg.setDelay(env.db, 10);
    await cfg.setDelay(env.db, 60);
    const after = await snapshot();

    expect(after.a2.audio_media_id).toBe(audio.id);
    expect(after.a2.photo_media_ids).toEqual(imgs.map((m) => m.id));
    expect(after).toEqual(before); // A1, audio/photos A2, connexion, contacts, médias : inchangés
    const d = await one(env.db, `SELECT delay_between_contacts_seconds FROM automation_configs WHERE automation_type='A2'`);
    expect(d.delay_between_contacts_seconds).toBe(60);
  });

  it('modifier Automation 2 (audio, photos) ne touche jamais Automation 1', async () => {
    await seedA2Config(env, 2, 10);
    const a1Before = await one(env.db, `SELECT * FROM automation_configs WHERE automation_type='A1'`);
    const newAudio = await one(env.db, `INSERT INTO media_assets (kind, source, name, external_url, status) VALUES ('audio','url','n.ogg','https://x/n.ogg','VALID') RETURNING id`);
    await cfg.setAudio(env.db, 'A2', newAudio.id);
    await cfg.setPhotos(env.db, []);
    await cfg.setPhotoCount(env.db, 4);
    expect(await one(env.db, `SELECT * FROM automation_configs WHERE automation_type='A1'`)).toEqual(a1Before);
  });

  it('le délai est validé : 1 s à 2 min', async () => {
    await expect(cfg.setDelay(env.db, 0)).rejects.toMatchObject({ statusCode: 400 });
    await expect(cfg.setDelay(env.db, 121)).rejects.toMatchObject({ statusCode: 400 });
    await expect(cfg.setDelay(env.db, 1)).resolves.toBeTruthy();
    await expect(cfg.setDelay(env.db, 120)).resolves.toBeTruthy();
  });

  it('une campagne en cours utilise son contenu figé même si la configuration change', async () => {
    await seedA2Config(env, 2, 10);
    await startA2(phones(2));
    await drainA2(env, { maxTicks: 1 });
    await cfg.setPhotoCount(env.db, 1);
    await drainA2(env);
    expect(perContact().map((c) => c.count)).toEqual([3, 3]);
  });
});
