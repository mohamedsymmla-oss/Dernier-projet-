import crypto from 'node:crypto';
import type { AutomationType } from '@wa/shared';
import { normalizePhone } from '@wa/shared';
import { many, one, withTx } from '../db/pool.js';
import type { AppContext } from '../context.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from './audit.js';
import { buildSnapshot, type RunSnapshot } from './automation-config.js';
import { currentA2Delay, maybeCompleteRun, nextContactDueAt } from './engine.js';

export type RunKind = 'SEQUENCE' | 'TEMPLATE' | 'TEST';

/** Statuts qui « occupent » la clé d'idempotence : le contact est considéré comme déjà automatisé. */
export const OCCUPYING_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'TEMPLATE_REQUIRED', 'NEEDS_REVIEW'];

export function idempotencyKey(mode: string, kind: RunKind, type: AutomationType, contactId: string) {
  const prefix = kind === 'TEMPLATE' ? `${type}T` : type;
  return `${mode}:${prefix}:${contactId}`;
}

export async function getActiveConnection(ctx: AppContext) {
  const conn = await one(
    ctx.db,
    `SELECT c.* FROM app_settings s JOIN provider_connections c ON c.id = s.active_connection_id WHERE s.id = 1`,
  );
  if (!conn) throw badRequest('Aucune connexion WhatsApp active : configurez-la dans « Connexion WhatsApp »');
  if (conn.status !== 'CONNECTED') {
    throw badRequest(`La connexion « ${conn.label} » n'est pas vérifiée (statut ${conn.status}). Lancez « Tester la connexion ».`);
  }
  if (!conn.phone_number) throw badRequest('Aucun numéro WhatsApp sélectionné pour cette connexion');
  return conn;
}

interface CreateRunInput {
  type: AutomationType;
  kind: RunKind;
  clientRequestId: string;
  importId?: string | null;
  contactIds?: string[];
  template?: { name: string; language: string };
  userId?: string | null;
}

/**
 * Crée une campagne. Protégé contre le double clic : clientRequestId est unique,
 * un second appel identique renvoie la même campagne. Une seule campagne active par automatisation.
 */
export async function createRun(ctx: AppContext, input: CreateRunInput) {
  const existing = await one(ctx.db, 'SELECT * FROM automation_runs WHERE client_request_id=$1', [input.clientRequestId]);
  if (existing) return { run: existing, created: false };

  const conn = await getActiveConnection(ctx);
  let snapshot: RunSnapshot;
  let version: number;
  if (input.kind === 'TEMPLATE') {
    if (!input.template) throw badRequest('Modèle WhatsApp non choisi');
    snapshot = {
      steps: [{ kind: 'template', label: `Modèle « ${input.template.name} »`, template: input.template }],
      windowPolicy: 'ALLOW_UNKNOWN',
    };
    version = 0;
  } else {
    ({ snapshot, version } = await buildSnapshot(ctx.db, input.type));
  }

  let run: any;
  try {
    run = await withTx(ctx.db, async (tx) => {
      const number = await one(tx, 'SELECT id FROM whatsapp_numbers WHERE phone_e164=$1', [conn.phone_number]);
      const inserted = await tx.query(
        `INSERT INTO automation_runs (automation_type, kind, status, mode, connection_id, whatsapp_number_id, sender_phone,
            client_request_id, import_id, config_snapshot, content_version, created_by, started_at)
         VALUES ($1,$2,'RUNNING',$3,$4,$5,$6,$7,$8,$9,$10,$11,now()) RETURNING *`,
        [
          input.type,
          input.kind,
          conn.mode,
          conn.id,
          number?.id ?? null,
          conn.phone_number,
          input.clientRequestId,
          input.importId ?? null,
          JSON.stringify(snapshot),
          version,
          input.userId ?? null,
        ],
      );
      const run = inserted.rows[0];

      let contactIds: string[];
      if (input.kind === 'SEQUENCE') {
        if (!input.importId) throw badRequest('Liste importée manquante');
        // Respecter l'ordre de la liste importée
        const ordered = await many(
          tx,
          `SELECT contact_id, min(line_number) AS l FROM contact_import_items
            WHERE import_id=$1 AND status='VALID' AND contact_id IS NOT NULL GROUP BY contact_id ORDER BY l`,
          [input.importId],
        );
        contactIds = ordered.map((r) => r.contact_id);
      } else {
        contactIds = input.contactIds ?? [];
      }

      let position = 0;
      for (const contactId of contactIds) {
        const contact = await one(tx, 'SELECT phone_e164 FROM contacts WHERE id=$1', [contactId]);
        if (!contact) continue;
        const key =
          input.kind === 'TEST' ? `TEST:${crypto.randomUUID()}` : idempotencyKey(conn.mode, input.kind, input.type, contactId);
        // Nouvelle ligne, ou « adoption » d'un destinataire annulé (jamais envoyé) d'une campagne arrêtée.
        const res = await tx.query(
          `INSERT INTO automation_recipients (run_id, contact_id, phone_e164, automation_type, idempotency_key, position, content_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (idempotency_key) DO UPDATE
             SET run_id=EXCLUDED.run_id, position=EXCLUDED.position, status='PENDING', content_version=EXCLUDED.content_version,
                 lease_until=NULL, last_error=NULL, last_error_kind=NULL, updated_at=now()
             WHERE automation_recipients.status = 'CANCELLED'
           RETURNING id`,
          [run.id, contactId, contact.phone_e164, input.type, key, position, version],
        );
        if (res.rowCount === 1) {
          // Si aucune étape n'a jamais été soumise, on régénère les étapes avec le contenu actuel.
          await tx.query(
            `DELETE FROM automation_steps WHERE recipient_id=$1
               AND NOT EXISTS (SELECT 1 FROM automation_steps s2 WHERE s2.recipient_id=$1 AND s2.status <> 'PENDING')`,
            [res.rows[0].id],
          );
          position++;
        }
      }
      if (position === 0) throw badRequest('Aucun destinataire éligible (tous déjà automatisés, invalides ou en doublon)');
      await tx.query('UPDATE automation_runs SET total=$2 WHERE id=$1', [run.id, position]);
      run.total = position;
      await audit(tx, 'run.created', {
        userId: input.userId,
        entityType: 'automation_run',
        entityId: run.id,
        details: { type: input.type, kind: input.kind, total: position, mode: conn.mode },
      });
      return run;
    });
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    if (err.code === '23505' && err.constraint === 'automation_runs_one_active') {
      throw conflict(`Une campagne ${input.type === 'A1' ? 'Automation 1' : 'Automation 2'} est déjà en cours ou en pause`);
    }
    if (err.code === '23505' && err.constraint === 'automation_runs_client_request_id_key') {
      const again = await one(ctx.db, 'SELECT * FROM automation_runs WHERE client_request_id=$1', [input.clientRequestId]);
      if (again) return { run: again, created: false };
    }
    throw e;
  }

  await dispatchRun(ctx, run);
  ctx.log.info({ run_id: run.id, type: run.automation_type, kind: run.kind, total: run.total }, 'run_started');
  return { run, created: true };
}

/** Programme le traitement d'une campagne selon son type. */
export async function dispatchRun(ctx: AppContext, run: any) {
  if (run.automation_type === 'A2' && run.kind === 'SEQUENCE') {
    const due = await nextContactDueAt(ctx, run);
    const wait = due ? Math.max(0, due.getTime() - ctx.clock.now().getTime()) : 0;
    await ctx.scheduler.scheduleA2Tick(run.id, run.tick_seq, wait);
    return;
  }
  const pending = await many(
    ctx.db,
    `SELECT id FROM automation_recipients WHERE run_id=$1
       AND (status='PENDING' OR (status='IN_PROGRESS' AND lease_until < now())) ORDER BY position`,
    [run.id],
  );
  for (const p of pending) await ctx.scheduler.enqueueRecipient(run.id, p.id, run.epoch);
  if (pending.length === 0) await maybeCompleteRun(ctx, run.id);
}

export async function pauseRun(ctx: AppContext, runId: string, userId?: string | null) {
  const r = await one(
    ctx.db,
    `UPDATE automation_runs SET status='PAUSED', paused_at=now(), pause_reason='Pause demandée', updated_at=now()
      WHERE id=$1 AND status='RUNNING' RETURNING *`,
    [runId],
  );
  if (!r) throw conflict("La campagne n'est pas en cours");
  await audit(ctx.db, 'run.paused', { userId, entityType: 'automation_run', entityId: runId });
  return r;
}

export async function resumeRun(ctx: AppContext, runId: string, userId?: string | null) {
  const r = await one(
    ctx.db,
    `UPDATE automation_runs SET status='RUNNING', paused_at=NULL, pause_reason=NULL, epoch=epoch+1, updated_at=now()
      WHERE id=$1 AND status='PAUSED' RETURNING *`,
    [runId],
  );
  if (!r) throw conflict("La campagne n'est pas en pause");
  const conn = await one(ctx.db, 'SELECT status FROM provider_connections WHERE id=$1', [r.connection_id]);
  if (conn?.status === 'DISCONNECTED') {
    await ctx.db.query(`UPDATE automation_runs SET status='PAUSED', pause_reason='Connexion déconnectée' WHERE id=$1`, [runId]);
    throw badRequest('La connexion utilisée par cette campagne est déconnectée : reconnectez-la avant de reprendre');
  }
  await audit(ctx.db, 'run.resumed', { userId, entityType: 'automation_run', entityId: runId });
  await dispatchRun(ctx, r);
  return r;
}

/** Arrêt propre : le contact en cours termine sa séquence, les suivants sont annulés. L'historique est conservé. */
export async function stopRun(ctx: AppContext, runId: string, userId?: string | null) {
  const r = await withTx(ctx.db, async (tx) => {
    const run = await one(
      tx,
      `UPDATE automation_runs SET status='STOPPED', stopped_at=now(), updated_at=now()
        WHERE id=$1 AND status IN ('RUNNING','PAUSED') RETURNING *`,
      [runId],
    );
    if (!run) throw conflict('La campagne est déjà terminée ou arrêtée');
    const cancelled = await tx.query(
      `UPDATE automation_recipients SET status='CANCELLED', updated_at=now() WHERE run_id=$1 AND status='PENDING'`,
      [runId],
    );
    await audit(tx, 'run.stopped', { userId, entityType: 'automation_run', entityId: runId, details: { cancelled: cancelled.rowCount } });
    return run;
  });
  return r;
}

/**
 * Relance les destinataires en échec « récupérable » d'une campagne :
 * uniquement les étapes non acceptées sont renvoyées (jamais celles déjà acceptées).
 * Par défaut : erreurs temporaires épuisées et modèles requis. Les étapes incertaines seulement si confirmé.
 */
export async function retryRecipients(
  ctx: AppContext,
  opts: { runId?: string; recipientId?: string; includeUncertain?: boolean; userId?: string | null },
) {
  const run = opts.runId
    ? await one(ctx.db, 'SELECT * FROM automation_runs WHERE id=$1', [opts.runId])
    : await one(ctx.db, 'SELECT run.* FROM automation_runs run JOIN automation_recipients r ON r.run_id=run.id WHERE r.id=$1', [opts.recipientId]);
  if (!run) throw notFound('Campagne');
  if (run.status === 'PAUSED') throw conflict("Reprenez d'abord la campagne");

  const statuses = ['FAILED', 'TEMPLATE_REQUIRED', ...(opts.includeUncertain ? ['NEEDS_REVIEW'] : [])];
  const recipients = await many(
    ctx.db,
    `SELECT id FROM automation_recipients WHERE run_id=$1 AND status = ANY($2) ${opts.recipientId ? 'AND id=$3' : ''}`,
    opts.recipientId ? [run.id, statuses, opts.recipientId] : [run.id, statuses],
  );
  if (recipients.length === 0) return { retried: 0 };
  const ids = recipients.map((r) => r.id);

  const updated = await withTx(ctx.db, async (tx) => {
    // Les erreurs définitives sur le destinataire ou le média ne sont pas relancées automatiquement
    await tx.query(
      `UPDATE automation_steps SET status='PENDING', last_error=NULL, last_error_kind=NULL, updated_at=now()
        WHERE recipient_id = ANY($1::uuid[]) AND (
          (status='FAILED' AND coalesce(last_error_kind,'') NOT IN ('INVALID_RECIPIENT','INVALID_MEDIA','PERMANENT','NOT_AVAILABLE'))
          OR (status='UNCERTAIN' AND $2)
          OR (status='PENDING'))`,
      [ids, !!opts.includeUncertain],
    );
    const res = await tx.query(
      `UPDATE automation_recipients r SET status='PENDING', lease_until=NULL, updated_at=now()
        WHERE id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM automation_steps s WHERE s.recipient_id=r.id AND s.status IN ('FAILED','UNCERTAIN'))
        RETURNING id`,
      [ids],
    );
    if (res.rowCount && run.status !== 'RUNNING') {
      await tx.query(
        `UPDATE automation_runs SET status='RUNNING', completed_at=NULL, stopped_at=NULL, epoch=epoch+1, updated_at=now() WHERE id=$1`,
        [run.id],
      );
    }
    await audit(tx, 'run.retry', { userId: opts.userId, entityType: 'automation_run', entityId: run.id, details: { count: res.rowCount } });
    return res.rowCount ?? 0;
  }).catch((e) => {
    if (e.code === '23505') throw conflict('Une autre campagne de ce type est active : attendez sa fin pour relancer');
    throw e;
  });
  const fresh = await one(ctx.db, 'SELECT * FROM automation_runs WHERE id=$1', [run.id]);
  await dispatchRun(ctx, fresh);
  return { retried: updated, skippedPermanent: ids.length - updated };
}

/** Test de la séquence sur le numéro de test uniquement. */
export async function startTestRun(ctx: AppContext, type: AutomationType, clientRequestId: string, userId?: string | null) {
  const settings = await one(ctx.db, 'SELECT test_phone_e164 FROM app_settings WHERE id=1');
  if (!settings?.test_phone_e164) throw badRequest('Définissez d’abord un numéro de test dans Réglages');
  const n = normalizePhone(settings.test_phone_e164);
  if (!n.ok) throw badRequest('Numéro de test invalide');
  const contact = await upsertContact(ctx, n.e164);
  return createRun(ctx, { type, kind: 'TEST', clientRequestId, contactIds: [contact.id], userId });
}

export async function upsertContact(ctx: AppContext, e164: string, importId?: string | null) {
  return (await one(
    ctx.db,
    `INSERT INTO contacts (phone_e164, first_import_id) VALUES ($1,$2)
     ON CONFLICT (phone_e164) DO UPDATE SET updated_at = contacts.updated_at RETURNING *`,
    [e164, importId ?? null],
  ))!;
}

export async function getRunProgress(ctx: AppContext, runId: string) {
  const run = await one(ctx.db, 'SELECT * FROM automation_runs WHERE id=$1', [runId]);
  if (!run) throw notFound('Campagne');
  const counts = await many(
    ctx.db,
    'SELECT status, count(*)::int AS n FROM automation_recipients WHERE run_id=$1 GROUP BY status',
    [runId],
  );
  const by: Record<string, number> = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const done = by.COMPLETED ?? 0;
  const failed = (by.FAILED ?? 0) + (by.TEMPLATE_REQUIRED ?? 0) + (by.NEEDS_REVIEW ?? 0);
  const pending = by.PENDING ?? 0;
  const inProgress = by.IN_PROGRESS ?? 0;

  let a2: Record<string, unknown> | null = null;
  if (run.automation_type === 'A2' && run.kind === 'SEQUENCE') {
    const delay = await currentA2Delay(ctx);
    const due = await nextContactDueAt(ctx, run);
    const nextRecipient = await one(
      ctx.db,
      `SELECT id, phone_e164 FROM automation_recipients WHERE run_id=$1 AND status IN ('IN_PROGRESS','PENDING')
        ORDER BY (status='IN_PROGRESS') DESC, position LIMIT 1`,
      [runId],
    );
    a2 = {
      delaySeconds: delay,
      nextContactPhone: nextRecipient?.phone_e164 ?? null,
      nextSendAt: run.status === 'RUNNING' && !inProgress ? due?.toISOString() ?? null : null,
      currentlyProcessing: inProgress > 0,
    };
  }
  const steps = await many(
    ctx.db,
    `SELECT s.status, count(*)::int AS n FROM automation_steps s JOIN automation_recipients r ON r.id=s.recipient_id
      WHERE r.run_id=$1 GROUP BY s.status`,
    [runId],
  );
  return {
    run: publicRun(run),
    counts: {
      total,
      completed: done,
      remaining: pending + inProgress,
      failed,
      inProgress,
      cancelled: by.CANCELLED ?? 0,
      byStatus: by,
      steps: Object.fromEntries(steps.map((s) => [s.status, s.n])),
    },
    a2,
    serverTime: ctx.clock.now().toISOString(),
  };
}

export function publicRun(run: any) {
  return {
    id: run.id,
    automationType: run.automation_type,
    kind: run.kind,
    status: run.status,
    mode: run.mode,
    connectionId: run.connection_id,
    senderPhone: run.sender_phone,
    total: run.total,
    snapshot: run.config_snapshot,
    pauseReason: run.pause_reason,
    createdAt: run.created_at,
    startedAt: run.started_at,
    pausedAt: run.paused_at,
    stoppedAt: run.stopped_at,
    completedAt: run.completed_at,
    lastContactFinishedAt: run.last_contact_finished_at,
  };
}

/**
 * Reconstruit l'état des files à partir de PostgreSQL (démarrage du worker + balayage périodique).
 * Idempotent : peut être exécuté à tout moment sans provoquer de double envoi.
 */
export async function recoverRuns(ctx: AppContext) {
  const runs = await many(ctx.db, `SELECT * FROM automation_runs WHERE status='RUNNING'`);
  for (const run of runs) {
    try {
      await dispatchRun(ctx, run);
    } catch (e) {
      ctx.log.error({ run_id: run.id, err: e }, 'recover_run_failed');
    }
  }
  const pendingWebhooks = await many(
    ctx.db,
    `SELECT id FROM webhook_events WHERE process_status='PENDING' AND received_at < now() - interval '20 seconds' LIMIT 500`,
  );
  for (const w of pendingWebhooks) await ctx.scheduler.enqueueWebhookEvent(w.id);
  return { runs: runs.length, webhooks: pendingWebhooks.length };
}

export function assertType(t: string): AutomationType {
  if (t !== 'A1' && t !== 'A2') throw new AppError(400, 'BAD_TYPE', 'Automatisation inconnue');
  return t;
}
