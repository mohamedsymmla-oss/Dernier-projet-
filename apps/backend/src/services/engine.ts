import { ProviderError, toProviderError, type OutboundMessage } from '@wa/provider-connectors';
import { many, one, withTx } from '../db/pool.js';
import type { AppContext, ConnectionRow } from '../context.js';
import type { RunSnapshot } from './automation-config.js';
import { checkFreeFormWindow } from './window.js';

/**
 * MOTEUR D'ENVOI
 *
 * Garanties :
 *  - Anti-doublon : un destinataire = une ligne unique (clé d'idempotence) ; chaque étape a un statut
 *    persistant. Une étape ACCEPTED n'est jamais renvoyée.
 *  - Reprise : après un crash, seules les étapes manquantes sont envoyées.
 *  - Une étape restée « SUBMITTING » (crash pendant l'appel HTTP) devient « UNCERTAIN » :
 *    on ne sait pas si le fournisseur l'a reçue → PAS de renvoi automatique, vérification manuelle.
 *  - Erreurs temporaires (timeout, 429, 5xx) : nouvelles tentatives avec backoff exponentiel, bornées.
 *  - Erreurs définitives : enregistrées, pas de boucle.
 *  - Authentification refusée : la campagne est mise en pause (tous les envois échoueraient).
 */

export const LEASE_SECONDS = 120;

export type ProcessOutcome =
  | { outcome: 'completed'; sent: number }
  | { outcome: 'failed'; sent: number; reason: string }
  | { outcome: 'blocked'; sent: number; reason: string } // modèle requis / vérification requise
  | { outcome: 'paused'; sent: number; reason: string }
  | { outcome: 'skipped'; sent: 0; reason: string };

interface ClaimedRecipient {
  id: string;
  run_id: string;
  contact_id: string;
  phone_e164: string;
  automation_type: 'A1' | 'A2';
  run_kind: 'SEQUENCE' | 'TEMPLATE' | 'TEST';
  run_mode: 'PRODUCTION' | 'TEST';
  connection_id: string;
  config_snapshot: RunSnapshot;
  sender_phone: string;
}

interface StepRow {
  id: string;
  step_index: number;
  kind: 'audio' | 'text' | 'image' | 'template';
  label: string;
  media_id: string | null;
  text_body: string | null;
  template: { name: string; language: string } | null;
  status: string;
  attempts: number;
}

export function backoffMs(ctx: AppContext, attempt: number, retryAfterMs?: number | null): number {
  const exp = Math.min(ctx.config.RETRY_MAX_MS, ctx.config.RETRY_BASE_MS * 2 ** (attempt - 1));
  const jitter = Math.floor(exp * 0.2 * Math.random());
  return Math.max(exp + jitter, retryAfterMs ?? 0);
}

async function claim(ctx: AppContext, recipientId: string): Promise<ClaimedRecipient | null> {
  return one<ClaimedRecipient>(
    ctx.db,
    `UPDATE automation_recipients r
        SET status='IN_PROGRESS', lease_until = now() + ($2 || ' seconds')::interval,
            started_at = coalesce(r.started_at, now()), updated_at = now()
       FROM automation_runs run
      WHERE r.id = $1 AND run.id = r.run_id AND run.status = 'RUNNING'
        AND (r.status = 'PENDING' OR (r.status = 'IN_PROGRESS' AND r.lease_until < now()))
      RETURNING r.id, r.run_id, r.contact_id, r.phone_e164, r.automation_type,
                run.kind AS run_kind, run.mode AS run_mode, run.connection_id,
                run.config_snapshot, run.sender_phone`,
    [recipientId, String(LEASE_SECONDS)],
  );
}

async function renewLease(ctx: AppContext, recipientId: string) {
  await ctx.db.query(
    `UPDATE automation_recipients SET lease_until = now() + ($2 || ' seconds')::interval WHERE id=$1 AND status='IN_PROGRESS'`,
    [recipientId, String(LEASE_SECONDS)],
  );
}

/** Dort en renouvelant le bail (évite qu'un autre worker reprenne le destinataire pendant une attente). */
async function sleepWithLease(ctx: AppContext, recipientId: string, ms: number) {
  let left = ms;
  while (left > 0) {
    const chunk = Math.min(left, (LEASE_SECONDS / 3) * 1000);
    await ctx.clock.sleep(chunk);
    left -= chunk;
    await renewLease(ctx, recipientId);
  }
}

const COLUMN_PREFIX = { A1: 'a1', A2: 'a2' } as const;

async function updateContactStatus(
  ctx: AppContext,
  r: ClaimedRecipient,
  status: string,
  opts: { firstSent?: boolean; completed?: boolean; error?: string | null } = {},
) {
  // Les campagnes de test et le mode TEST ne modifient jamais le statut « production » du contact.
  if (r.run_kind !== 'SEQUENCE' || r.run_mode !== 'PRODUCTION') return;
  const p = COLUMN_PREFIX[r.automation_type];
  await ctx.db.query(
    `UPDATE contacts SET ${p}_status=$2, ${p}_run_id=$3,
        ${p}_first_sent_at = CASE WHEN $4 THEN coalesce(${p}_first_sent_at, $6) ELSE ${p}_first_sent_at END,
        ${p}_completed_at = CASE WHEN $5 THEN $6 ELSE ${p}_completed_at END,
        last_error = CASE WHEN $7::text IS NOT NULL THEN $7 ELSE last_error END,
        updated_at = now()
      WHERE id=$1`,
    [r.contact_id, status, r.run_id, !!opts.firstSent, !!opts.completed, ctx.clock.now(), opts.error ?? null],
  );
}

async function finishRecipient(ctx: AppContext, id: string, status: string, error?: { message: string; kind?: string } | null) {
  await ctx.db.query(
    `UPDATE automation_recipients SET status=$2, lease_until=NULL, updated_at=now(),
        completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE completed_at END,
        last_error = $3, last_error_kind = $4
      WHERE id=$1`,
    [id, status, error?.message ?? null, error?.kind ?? null],
  );
}

async function ensureSteps(ctx: AppContext, r: ClaimedRecipient): Promise<StepRow[]> {
  let steps = await many<StepRow>(ctx.db, 'SELECT * FROM automation_steps WHERE recipient_id=$1 ORDER BY step_index', [r.id]);
  if (steps.length === 0) {
    const snap = r.config_snapshot;
    await withTx(ctx.db, async (tx) => {
      for (const [i, s] of snap.steps.entries()) {
        await tx.query(
          `INSERT INTO automation_steps (recipient_id, step_index, kind, label, media_id, text_body, template)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (recipient_id, step_index) DO NOTHING`,
          [r.id, i, s.kind, s.label, s.mediaId ?? null, s.text ?? null, s.template ? JSON.stringify(s.template) : null],
        );
      }
    });
    steps = await many<StepRow>(ctx.db, 'SELECT * FROM automation_steps WHERE recipient_id=$1 ORDER BY step_index', [r.id]);
  }
  return steps;
}

export async function resolveMediaUrl(ctx: AppContext, mediaId: string): Promise<string> {
  const m = await one(ctx.db, 'SELECT source, storage_key, external_url FROM media_assets WHERE id=$1', [mediaId]);
  if (!m) throw new ProviderError('INVALID_MEDIA', 'Média introuvable');
  if (m.source === 'url') return m.external_url;
  if (!m.storage_key) throw new ProviderError('INVALID_MEDIA', 'Fichier média absent du stockage');
  return ctx.storage.publicUrl(m.storage_key);
}

export async function buildOutbound(ctx: AppContext, step: Pick<StepRow, 'kind' | 'media_id' | 'text_body' | 'template'>): Promise<OutboundMessage> {
  switch (step.kind) {
    case 'text':
      return { kind: 'text', body: step.text_body ?? '' };
    case 'audio':
      return { kind: 'audio', media: { link: await resolveMediaUrl(ctx, step.media_id!) } };
    case 'image':
      return { kind: 'image', media: { link: await resolveMediaUrl(ctx, step.media_id!) } };
    case 'template':
      return { kind: 'template', name: step.template!.name, languageCode: step.template!.language };
  }
}

async function pauseRun(ctx: AppContext, runId: string, reason: string) {
  await ctx.db.query(
    `UPDATE automation_runs SET status='PAUSED', paused_at=now(), pause_reason=$2, updated_at=now()
      WHERE id=$1 AND status='RUNNING'`,
    [runId, reason],
  );
  ctx.log.warn({ run_id: runId, reason }, 'run_auto_paused');
}

/** Clôture une campagne quand plus aucun destinataire n'est en attente. */
export async function maybeCompleteRun(ctx: AppContext, runId: string): Promise<boolean> {
  const r = await one(
    ctx.db,
    `UPDATE automation_runs SET status='COMPLETED', completed_at=now(), current_recipient_id=NULL, updated_at=now()
      WHERE id=$1 AND status='RUNNING'
        AND NOT EXISTS (SELECT 1 FROM automation_recipients WHERE run_id=$1 AND status IN ('PENDING','IN_PROGRESS'))
      RETURNING id`,
    [runId],
  );
  if (r) ctx.log.info({ run_id: runId }, 'run_completed');
  return !!r;
}

type StepResult = { ok: true } | { ok: false; outcome: ProcessOutcome['outcome']; reason: string };

async function sendStep(
  ctx: AppContext,
  r: ClaimedRecipient,
  conn: ConnectionRow,
  step: StepRow,
): Promise<StepResult> {
  const log = ctx.log.child({ run_id: r.run_id, recipient_id: r.id, step_id: step.id });
  let attempts = step.attempts;
  for (;;) {
    // Préparer AVANT de marquer SUBMITTING (une erreur ici n'a rien envoyé).
    let message: OutboundMessage;
    try {
      message = await buildOutbound(ctx, step);
    } catch (e) {
      const pe = toProviderError(e);
      await ctx.db.query(
        `UPDATE automation_steps SET status='FAILED', last_error=$2, last_error_kind=$3, updated_at=now() WHERE id=$1`,
        [step.id, pe.message, 'INVALID_MEDIA'],
      );
      return { ok: false, outcome: 'failed', reason: `${step.label} : ${pe.message}` };
    }
    await ctx.rateLimiter.acquire(conn.id);

    attempts += 1;
    const outboundId = await withTx(ctx.db, async (tx) => {
      const upd = await tx.query(
        `UPDATE automation_steps SET status='SUBMITTING', attempts=$2, submitted_at=now(), updated_at=now()
          WHERE id=$1 AND status='PENDING'`,
        [step.id, attempts],
      );
      if (upd.rowCount !== 1) return null;
      const o = await tx.query(
        `INSERT INTO outbound_messages (connection_id, provider, run_id, recipient_id, step_id, contact_id, to_phone, kind,
            is_test, status, attempt, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUBMITTING',$10,now()) RETURNING id`,
        [conn.id, conn.provider, r.run_id, r.id, step.id, r.contact_id, r.phone_e164, step.kind, r.run_kind === 'TEST' || r.run_mode === 'TEST', attempts],
      );
      await tx.query('UPDATE automation_steps SET outbound_message_id=$2 WHERE id=$1', [step.id, o.rows[0].id]);
      return o.rows[0].id as string;
    });
    if (!outboundId) return { ok: false, outcome: 'skipped', reason: 'Étape déjà prise en charge' };

    const connector = ctx.connectorFor(conn, { runId: r.run_id, recipientId: r.id, stepId: step.id, attempt: attempts });
    try {
      const res = await connector.send(
        { phoneNumber: r.sender_phone, phoneNumberId: conn.phone_number_id ?? '', wabaId: conn.waba_id ?? '' },
        r.phone_e164,
        message,
      );
      await withTx(ctx.db, async (tx) => {
        await tx.query(
          `UPDATE outbound_messages SET status='ACCEPTED', provider_message_id=$2, http_status=$3, request_id=$4,
              accepted_at=now(), updated_at=now() WHERE id=$1`,
          [outboundId, res.providerMessageId, res.httpStatus, res.requestId],
        );
        await tx.query(
          `UPDATE automation_steps SET status='ACCEPTED', accepted_at=now(), last_error=NULL, last_error_kind=NULL, updated_at=now() WHERE id=$1`,
          [step.id],
        );
      });
      log.info({ message_id: res.providerMessageId, kind: step.kind, attempt: attempts }, 'step_accepted');
      return { ok: true };
    } catch (e) {
      const pe = toProviderError(e);
      await ctx.db.query(
        `UPDATE outbound_messages SET status='FAILED', failed_at=now(), http_status=$2, error_code=$3, error_message=$4,
            request_id=$5, updated_at=now() WHERE id=$1`,
        [outboundId, pe.details.httpStatus ?? null, pe.details.code ?? pe.kind, pe.message, pe.details.requestId ?? null],
      );
      log.warn({ kind: pe.kind, attempt: attempts, error: pe.message }, 'step_error');

      if (pe.retryable && attempts < ctx.config.SEND_MAX_ATTEMPTS) {
        await ctx.db.query(
          `UPDATE automation_steps SET status='PENDING', last_error=$2, last_error_kind=$3, updated_at=now() WHERE id=$1`,
          [step.id, pe.message, pe.kind],
        );
        if (pe.kind === 'RATE_LIMITED') await ctx.rateLimiter.block(conn.id, pe.details.retryAfterMs ?? backoffMs(ctx, attempts));
        await sleepWithLease(ctx, r.id, backoffMs(ctx, attempts, pe.details.retryAfterMs));
        continue;
      }
      if (pe.kind === 'AUTH') {
        // Rien n'a été envoyé : on remet l'étape en attente (tentative non comptée) et on suspend la campagne.
        await ctx.db.query(
          `UPDATE automation_steps SET status='PENDING', attempts=attempts-1, last_error=$2, last_error_kind='AUTH', updated_at=now() WHERE id=$1`,
          [step.id, pe.message],
        );
        return { ok: false, outcome: 'paused', reason: `Authentification refusée par le fournisseur : ${pe.message}` };
      }
      const finalKind = pe.retryable ? `${pe.kind}_EXHAUSTED` : pe.kind;
      await ctx.db.query(
        `UPDATE automation_steps SET status='FAILED', last_error=$2, last_error_kind=$3, updated_at=now() WHERE id=$1`,
        [step.id, pe.message, finalKind],
      );
      if (pe.kind === 'WINDOW_CLOSED') {
        return { ok: false, outcome: 'blocked', reason: 'Modèle WhatsApp requis : ' + pe.message };
      }
      return { ok: false, outcome: 'failed', reason: `${step.label} : ${pe.message}` };
    }
  }
}

/**
 * Traite un destinataire : envoie dans l'ordre les étapes manquantes (audio → texte 1 → texte 2, ou audio → photos).
 * Idempotent : peut être appelé plusieurs fois pour le même destinataire sans double envoi.
 */
export async function processRecipient(ctx: AppContext, recipientId: string): Promise<ProcessOutcome> {
  const r = await claim(ctx, recipientId);
  if (!r) return { outcome: 'skipped', sent: 0, reason: 'Destinataire non disponible (déjà traité, en cours, ou campagne en pause)' };
  const log = ctx.log.child({ run_id: r.run_id, recipient_id: r.id });

  const conn = await one<ConnectionRow>(ctx.db, 'SELECT * FROM provider_connections WHERE id=$1', [r.connection_id]);
  if (!conn || conn.status === 'DISCONNECTED' || !conn.api_key_enc) {
    await ctx.db.query(`UPDATE automation_recipients SET status='PENDING', lease_until=NULL WHERE id=$1`, [r.id]);
    await pauseRun(ctx, r.run_id, 'Connexion fournisseur déconnectée : reconnectez puis reprenez');
    return { outcome: 'paused', sent: 0, reason: 'Connexion déconnectée' };
  }

  const steps = await ensureSteps(ctx, r);
  let sent = 0;
  const policy = r.config_snapshot.windowPolicy ?? 'ALLOW_UNKNOWN';

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.status === 'ACCEPTED' || step.status === 'SKIPPED') continue;
    if (step.status === 'SUBMITTING' || step.status === 'UNCERTAIN') {
      // Crash pendant l'appel HTTP : impossible de savoir si le message est parti → pas de renvoi automatique.
      await ctx.db.query(
        `UPDATE automation_steps SET status='UNCERTAIN', last_error=$2, updated_at=now() WHERE id=$1`,
        [step.id, "Interruption pendant l'envoi : le message a peut-être été reçu. Vérifiez puis relancez manuellement."],
      );
      await ctx.db.query(`UPDATE outbound_messages SET status='UNCERTAIN', updated_at=now() WHERE step_id=$1 AND status='SUBMITTING'`, [step.id]);
      const reason = `${step.label} : résultat incertain après interruption`;
      await finishRecipient(ctx, r.id, 'NEEDS_REVIEW', { message: reason, kind: 'UNCERTAIN' });
      await updateContactStatus(ctx, r, 'NEEDS_REVIEW', { error: reason });
      return { outcome: 'blocked', sent, reason };
    }
    if (step.status === 'FAILED') {
      await finishRecipient(ctx, r.id, 'FAILED', { message: `${step.label} en échec`, kind: 'FAILED' });
      return { outcome: 'failed', sent, reason: `${step.label} en échec` };
    }

    // Conformité : vérifier la fenêtre de conversation avant chaque message libre.
    if (step.kind !== 'template') {
      const contact = await one(ctx.db, 'SELECT last_inbound_at FROM contacts WHERE id=$1', [r.contact_id]);
      const decision = checkFreeFormWindow(contact?.last_inbound_at ?? null, policy, ctx.clock.now());
      if (!decision.allowed) {
        await ctx.db.query(`UPDATE automation_steps SET last_error=$2, last_error_kind='WINDOW_CLOSED' WHERE id=$1`, [step.id, decision.reason]);
        await finishRecipient(ctx, r.id, 'TEMPLATE_REQUIRED', { message: decision.reason, kind: 'WINDOW_CLOSED' });
        await updateContactStatus(ctx, r, 'TEMPLATE_REQUIRED', { error: decision.reason });
        log.info({ reason: decision.reason }, 'template_required');
        return { outcome: 'blocked', sent, reason: decision.reason };
      }
    }

    const res = await sendStep(ctx, r, conn, step);
    if (!res.ok) {
      if (res.outcome === 'paused') {
        await ctx.db.query(`UPDATE automation_recipients SET status='PENDING', lease_until=NULL, last_error=$2 WHERE id=$1`, [r.id, res.reason]);
        await pauseRun(ctx, r.run_id, res.reason);
        return { outcome: 'paused', sent, reason: res.reason };
      }
      if (res.outcome === 'skipped') return { outcome: 'skipped', sent: 0, reason: res.reason };
      const status = res.outcome === 'blocked' ? 'TEMPLATE_REQUIRED' : 'FAILED';
      await finishRecipient(ctx, r.id, status, { message: res.reason, kind: status });
      await updateContactStatus(ctx, r, status, { firstSent: sent > 0, error: res.reason });
      return { outcome: res.outcome === 'blocked' ? 'blocked' : 'failed', sent, reason: res.reason };
    }
    sent += 1;
    if (sent === 1) await updateContactStatus(ctx, r, 'IN_PROGRESS', { firstSent: true });
    await renewLease(ctx, r.id);
    // Petit intervalle entre les messages d'une même séquence pour préserver l'ordre d'arrivée.
    if (i < steps.length - 1 && ctx.config.STEP_GAP_MS > 0) await ctx.clock.sleep(ctx.config.STEP_GAP_MS);
  }

  await finishRecipient(ctx, r.id, 'COMPLETED');
  await updateContactStatus(ctx, r, 'COMPLETED', { completed: true });
  log.info({ sent }, 'recipient_completed');
  return { outcome: 'completed', sent };
}

/** Job Automation 1 (et campagnes TEST / MODÈLE) : un destinataire, concurrence gérée par la file. */
export async function handleRecipientJob(ctx: AppContext, runId: string, recipientId: string) {
  const res = await processRecipient(ctx, recipientId);
  await maybeCompleteRun(ctx, runId);
  return res;
}

/**
 * AUTOMATION 2 — file lente, un contact à la fois.
 *
 * Un seul « tick » actif par campagne (compare-and-swap sur tick_seq).
 * Sémantique du délai : contact N traité et accepté → attendre `delay` → contact N+1.
 * Le moment de fin du contact précédent est persisté (last_contact_finished_at) :
 * après un redémarrage, pause ou changement de délai, le prochain contact ne démarre
 * jamais avant last_contact_finished_at + délai courant.
 */
export async function a2Tick(ctx: AppContext, runId: string, seq: number): Promise<string> {
  const run = await one(
    ctx.db,
    `UPDATE automation_runs SET tick_seq = tick_seq + 1, updated_at=now()
      WHERE id=$1 AND tick_seq=$2 AND status='RUNNING' RETURNING *`,
    [runId, seq],
  );
  if (!run) return 'stale';
  const nextSeq = seq + 1;
  const log = ctx.log.child({ run_id: runId });

  const due = await nextContactDueAt(ctx, run);
  const now = ctx.clock.now().getTime();
  if (due && now < due.getTime()) {
    await ctx.scheduler.scheduleA2Tick(runId, nextSeq, due.getTime() - now);
    return 'waiting';
  }

  const busy = await one(
    ctx.db,
    `SELECT id, extract(epoch from (lease_until - now())) * 1000 AS remaining_ms FROM automation_recipients
      WHERE run_id=$1 AND status='IN_PROGRESS' AND lease_until > now() LIMIT 1`,
    [runId],
  );
  if (busy) {
    await ctx.scheduler.scheduleA2Tick(runId, nextSeq, Math.ceil(Number(busy.remaining_ms)) + 1000);
    return 'busy';
  }

  const next = await one(
    ctx.db,
    `SELECT id, phone_e164 FROM automation_recipients WHERE run_id=$1 AND status IN ('PENDING','IN_PROGRESS')
      ORDER BY position LIMIT 1`,
    [runId],
  );
  if (!next) {
    await maybeCompleteRun(ctx, runId);
    return 'completed';
  }
  await ctx.db.query('UPDATE automation_runs SET current_recipient_id=$2 WHERE id=$1', [runId, next.id]);
  log.info({ recipient_id: next.id }, 'a2_contact_start');
  const res = await processRecipient(ctx, next.id);
  if (res.outcome === 'paused' || res.outcome === 'skipped') return res.outcome;

  if (res.sent > 0) {
    await ctx.db.query(
      'UPDATE automation_runs SET last_contact_finished_at=$2, current_recipient_id=NULL, updated_at=now() WHERE id=$1',
      [runId, ctx.clock.now()],
    );
  } else {
    await ctx.db.query('UPDATE automation_runs SET current_recipient_id=NULL WHERE id=$1', [runId]);
  }
  if (await maybeCompleteRun(ctx, runId)) return 'completed';

  const fresh = await one(ctx.db, 'SELECT * FROM automation_runs WHERE id=$1', [runId]);
  if (fresh?.status !== 'RUNNING') return 'paused';
  const nextDue = await nextContactDueAt(ctx, fresh);
  const wait = nextDue ? Math.max(0, nextDue.getTime() - ctx.clock.now().getTime()) : 0;
  await ctx.scheduler.scheduleA2Tick(runId, fresh.tick_seq, wait);
  return 'processed';
}

export async function currentA2Delay(ctx: AppContext): Promise<number> {
  const c = await one(ctx.db, `SELECT delay_between_contacts_seconds AS d FROM automation_configs WHERE automation_type='A2'`);
  return Number(c?.d ?? 60);
}

export async function nextContactDueAt(ctx: AppContext, run: { last_contact_finished_at: Date | null }): Promise<Date | null> {
  if (!run.last_contact_finished_at) return null;
  const delay = await currentA2Delay(ctx);
  return new Date(new Date(run.last_contact_finished_at).getTime() + delay * 1000);
}
