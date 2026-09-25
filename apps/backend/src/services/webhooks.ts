import { shouldApplyStatus, type MessageStatus } from '@wa/shared';
import { classifyByCode, hashPayload, type NormalizedEvent, type ProviderConnector } from '@wa/provider-connectors';
import { many, one, withTx, type DbClient } from '../db/pool.js';
import type { AppContext, ConnectionRow } from '../context.js';


const SAFE_HEADERS = ['content-type', 'user-agent', 'x-request-id', 'x-hub-signature-256', 'x-sendzen-event', 'x-event-id'];

function pickHeaders(h: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of SAFE_HEADERS) if (h[k] !== undefined) out[k] = k === 'x-hub-signature-256' ? '[présente]' : h[k];
  return out;
}

export type IngestResult =
  | { status: 'accepted'; eventId: string; duplicate: boolean }
  | { status: 'rejected'; httpStatus: number; reason: string };

/**
 * Réception d'un webhook : vérification de signature, stockage brut durable, anti-doublon,
 * puis mise en file du traitement. Doit être rapide : le fournisseur attend un 2xx.
 */
export async function ingestWebhook(
  ctx: AppContext,
  connectionId: string,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<IngestResult> {
  const conn = await one<ConnectionRow>(ctx.db, 'SELECT * FROM provider_connections WHERE id=$1', [connectionId]);
  if (!conn) return { status: 'rejected', httpStatus: 404, reason: 'Connexion inconnue' };

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    return { status: 'rejected', httpStatus: 400, reason: 'JSON invalide' };
  }

  // Vérification de signature (HMAC) si un secret webhook est configuré.
  let verified = false;
  let note: string;
  if (conn.webhook_secret_enc) {
    const connector = ctx.connectorFor(conn);
    const v = connector.verifyWebhook({ rawBody, headers });
    if (!v.verified) {
      ctx.log.warn({ connection_id: connectionId, reason: v.reason }, 'webhook_signature_rejected');
      await ctx.db.query(
        `INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('webhook.rejected','provider_connection',$1,$2)`,
        [connectionId, JSON.stringify({ reason: v.reason })],
      );
      return { status: 'rejected', httpStatus: 401, reason: v.reason };
    }
    verified = true;
    note = v.method;
  } else {
    note = 'Secret webhook non configuré : signature non vérifiée';
  }

  const eventIdHeader = headers['x-event-id'] ?? headers['x-sendzen-event-id'];
  const dedupeKey = `${conn.provider}:${connectionId}:${
    typeof eventIdHeader === 'string' && eventIdHeader ? 'id:' + eventIdHeader : 'sha:' + hashPayload(rawBody)
  }`;

  const inserted = await one(
    ctx.db,
    `INSERT INTO webhook_events (connection_id, provider, source, dedupe_key, payload, headers, signature_verified, verification_note)
     VALUES ($1,$2,'webhook',$3,$4,$5,$6,$7)
     ON CONFLICT (dedupe_key) DO UPDATE SET duplicate_count = webhook_events.duplicate_count + 1
     RETURNING id, (xmax <> 0) AS duplicate`,
    [connectionId, conn.provider, dedupeKey, JSON.stringify(payload), JSON.stringify(pickHeaders(headers)), verified, note],
  );
  await ctx.db.query(
    'UPDATE provider_connections SET last_webhook_at=now(), last_webhook_verified=$2 WHERE id=$1',
    [connectionId, verified],
  );
  const eventId = inserted!.id as string;
  const duplicate = !!inserted!.duplicate;
  ctx.log.info({ event_id: eventId, connection_id: connectionId, duplicate, verified }, 'webhook_received');
  if (!duplicate) {
    await ctx.scheduler.enqueueWebhookEvent(eventId).catch((e) => {
      // Redis indisponible : l'événement reste PENDING en base et sera traité par le balayage de reprise.
      ctx.log.error({ event_id: eventId, err: e }, 'webhook_enqueue_failed');
    });
  }
  return { status: 'accepted', eventId, duplicate };
}

/** Traite un événement stocké. Idempotent (clés d'unicité sur chaque sous-événement). */
export async function processWebhookEvent(ctx: AppContext, eventId: string) {
  const ev = await one(ctx.db, 'SELECT * FROM webhook_events WHERE id=$1', [eventId]);
  if (!ev || ev.process_status === 'PROCESSED') return { skipped: true };
  const conn = ev.connection_id
    ? await one<ConnectionRow>(ctx.db, 'SELECT * FROM provider_connections WHERE id=$1', [ev.connection_id])
    : null;
  try {
    const raw = Buffer.from(JSON.stringify(ev.payload));
    const parser = connectorParser(ctx, conn);
    const events = parser.parseWebhook(ev.payload, raw);
    let applied = 0;
    for (const e of events) applied += (await applyNormalizedEvent(ctx, e, { connectionId: ev.connection_id, webhookEventId: ev.id })) ? 1 : 0;
    await ctx.db.query(
      `UPDATE webhook_events SET process_status='PROCESSED', processed_at=now(), event_count=$2, process_error=NULL WHERE id=$1`,
      [eventId, events.length],
    );
    ctx.log.info({ event_id: eventId, events: events.length, applied }, 'webhook_processed');
    return { events: events.length, applied };
  } catch (e) {
    await ctx.db.query(`UPDATE webhook_events SET process_status='FAILED', process_error=$2 WHERE id=$1`, [
      eventId,
      (e as Error).message,
    ]);
    throw e;
  }
}

function connectorParser(ctx: AppContext, conn: ConnectionRow | null): Pick<ProviderConnector, 'parseWebhook'> {
  if (conn?.api_key_enc) return ctx.connectorFor(conn);
  // Connexion déconnectée (clé effacée) : on sait toujours lire le format de ses webhooks.
  return ctx.connectorFor({ ...(conn as ConnectionRow), provider: conn?.provider ?? 'sendzen', api_key_enc: ctx.secrets.encrypt('parse-only') });
}

/**
 * Applique un événement normalisé (webhook ou synchronisation des logs).
 * Retourne false si l'événement avait déjà été appliqué (anti-doublon webhook ↔ logs).
 */
export async function applyNormalizedEvent(
  ctx: AppContext,
  e: NormalizedEvent,
  opts: { connectionId: string | null; webhookEventId: string | null },
): Promise<boolean> {
  if (e.type === 'inbound_message') return applyInbound(ctx, e, opts);
  if (e.type === 'message_status') return applyStatus(ctx, e, opts);
  return false;
}

async function applyInbound(
  ctx: AppContext,
  e: Extract<NormalizedEvent, { type: 'inbound_message' }>,
  opts: { connectionId: string | null; webhookEventId: string | null },
) {
  return withTx(ctx.db, async (tx) => {
    const contact = await one(
      tx,
      `INSERT INTO contacts (phone_e164) VALUES ($1) ON CONFLICT (phone_e164) DO UPDATE SET updated_at=now() RETURNING *`,
      [e.from],
    );
    const ins = await tx.query(
      `INSERT INTO inbound_messages (provider, dedupe_key, provider_message_id, connection_id, webhook_event_id, contact_id,
          from_phone, to_phone_number_id, message_type, text, received_at, raw)
       VALUES ('sendzen',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [
        e.dedupeKey,
        e.providerMessageId,
        opts.connectionId,
        opts.webhookEventId,
        contact.id,
        e.from,
        e.toPhoneNumberId,
        e.messageType,
        e.text,
        e.timestamp,
        JSON.stringify(e.raw ?? null),
      ],
    );
    if (ins.rowCount === 0) return false; // déjà reçu

    await tx.query(
      `UPDATE contacts SET
          last_inbound_at = GREATEST(coalesce(last_inbound_at, $2), $2),
          last_inbound_message_id = CASE WHEN last_inbound_at IS NULL OR $2 >= last_inbound_at THEN $3 ELSE last_inbound_message_id END,
          last_inbound_type = CASE WHEN last_inbound_at IS NULL OR $2 >= last_inbound_at THEN $4 ELSE last_inbound_type END,
          last_inbound_text = CASE WHEN last_inbound_at IS NULL OR $2 >= last_inbound_at THEN $5 ELSE last_inbound_text END,
          last_reply_at = CASE WHEN EXISTS (SELECT 1 FROM outbound_messages o WHERE o.contact_id=$1 AND o.accepted_at < $2)
                               THEN GREATEST(coalesce(last_reply_at, $2), $2) ELSE last_reply_at END,
          updated_at = now()
        WHERE id=$1`,
      [contact.id, e.timestamp, e.providerMessageId, e.messageType, e.text?.slice(0, 1000) ?? null],
    );

    // Détection de réponse après Automation 1 (premier message reçu après le premier envoi A1).
    await markRespondedAfterA1(tx, contact.id, e, opts.connectionId);
    return true;
  });
}

async function markRespondedAfterA1(
  tx: DbClient,
  contactId: string,
  e: Extract<NormalizedEvent, { type: 'inbound_message' }>,
  connectionId: string | null,
) {
  await tx.query(
    `UPDATE contacts SET responded_after_a1 = true, responded_after_a1_at = $2, responded_after_a1_message_id = $3,
        responded_after_a1_message_type = $4, responded_after_a1_connection_id = $5
      WHERE id = $1 AND NOT responded_after_a1 AND a1_first_sent_at IS NOT NULL AND a1_first_sent_at < $2`,
    [contactId, e.timestamp, e.providerMessageId, e.messageType, connectionId],
  );
}

const TS_COLUMN: Record<string, string> = { SENT: 'sent_at', DELIVERED: 'delivered_at', READ: 'read_at', FAILED: 'failed_at' };

async function applyStatus(
  ctx: AppContext,
  e: Extract<NormalizedEvent, { type: 'message_status' }>,
  opts: { connectionId: string | null; webhookEventId: string | null },
) {
  return withTx(ctx.db, async (tx) => {
    const ins = await tx.query(
      `INSERT INTO message_status_events (provider, dedupe_key, provider_message_id, status, occurred_at, error_code, error_message, webhook_event_id)
       VALUES ('sendzen',$1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [e.dedupeKey, e.providerMessageId, e.status, e.timestamp, e.errorCode, e.errorMessage, opts.webhookEventId],
    );
    if (ins.rowCount === 0) return false;

    const msg = await one(tx, 'SELECT * FROM outbound_messages WHERE provider_message_id=$1 FOR UPDATE', [e.providerMessageId]);
    if (!msg) return true; // message envoyé hors de l'application : conservé dans message_status_events

    const col = TS_COLUMN[e.status]!;
    // Horodatage conservé même si le statut arrive dans le désordre
    await tx.query(`UPDATE outbound_messages SET ${col} = coalesce(${col}, $2), updated_at=now() WHERE id=$1`, [msg.id, e.timestamp]);
    if (shouldApplyStatus(msg.status as MessageStatus, e.status)) {
      await tx.query(
        `UPDATE outbound_messages SET status=$2, error_code=coalesce($3, error_code), error_message=coalesce($4, error_message) WHERE id=$1`,
        [msg.id, e.status, e.errorCode, e.errorMessage],
      );
      await tx.query('UPDATE message_status_events SET applied=true WHERE id=$1', [ins.rows[0].id]);
    }
    if (e.status === 'FAILED' && msg.recipient_id) {
      const kind = classifyByCode(e.errorCode);
      await tx.query(
        `UPDATE automation_recipients SET delivery_failed=true, last_error=$2, last_error_kind=$3, updated_at=now() WHERE id=$1`,
        [msg.recipient_id, `Échec de livraison : ${e.errorMessage ?? e.errorCode ?? 'inconnu'}`, kind ?? 'DELIVERY_FAILED'],
      );
      if (kind === 'WINDOW_CLOSED' && msg.contact_id && !msg.is_test) {
        const r = await one(tx, 'SELECT automation_type FROM automation_recipients WHERE id=$1', [msg.recipient_id]);
        const p = r?.automation_type === 'A2' ? 'a2' : 'a1';
        await tx.query(`UPDATE contacts SET ${p}_status='TEMPLATE_REQUIRED', last_error=$2 WHERE id=$1`, [
          msg.contact_id,
          'Modèle WhatsApp requis (fenêtre de 24 h fermée)',
        ]);
      }
    }
    return true;
  });
}

/**
 * RECHERCHER / SYNCHRONISER LES ÉVÉNEMENTS MANQUÉS
 *  1. Retraite les webhooks stockés mais non traités (ex : Redis indisponible).
 *  2. Interroge les logs du fournisseur (pagination) si le connecteur le permet.
 *  Anti-doublon : mêmes clés que les webhooks → un événement déjà reçu n'est jamais appliqué deux fois.
 */
export async function syncMissedEvents(ctx: AppContext, connectionId: string, sinceHours = 72) {
  const conn = await one<ConnectionRow>(ctx.db, 'SELECT * FROM provider_connections WHERE id=$1', [connectionId]);
  if (!conn) throw new Error('Connexion introuvable');
  const since = new Date(ctx.clock.now().getTime() - sinceHours * 3600_000);
  const sync = await one(ctx.db, `INSERT INTO sync_runs (connection_id, status, since) VALUES ($1,'RUNNING',$2) RETURNING id`, [
    connectionId,
    since,
  ]);

  let reprocessed = 0;
  const stuck = await many(
    ctx.db,
    `SELECT id FROM webhook_events WHERE connection_id=$1 AND process_status IN ('PENDING','FAILED') ORDER BY received_at LIMIT 1000`,
    [connectionId],
  );
  for (const s of stuck) {
    try {
      await processWebhookEvent(ctx, s.id);
      reprocessed++;
    } catch (e) {
      ctx.log.warn({ event_id: s.id, err: e }, 'reprocess_failed');
    }
  }

  const result = { syncId: sync!.id, reprocessed, logsAvailable: false, pages: 0, fetched: 0, newEvents: 0, duplicates: 0, detail: '' };
  if (!conn.api_key_enc) {
    result.detail = 'Connexion sans clé API : seuls les webhooks stockés ont été retraités';
  } else {
    const connector = ctx.connectorFor(conn);
    const cap = connector.capabilities().fetchLogs;
    if (cap.status === 'NOT_AVAILABLE') {
      result.detail = `Logs fournisseur non disponibles : ${cap.note}`;
    } else {
      result.logsAvailable = true;
      let cursor: string | null = null;
      do {
        const page = await connector.fetchLogs({ since, cursor });
        result.pages++;
        for (const ev of page.events) {
          result.fetched++;
          const applied = await applyNormalizedEvent(ctx, ev, { connectionId, webhookEventId: null });
          if (applied) result.newEvents++;
          else result.duplicates++;
        }
        cursor = page.nextCursor;
      } while (cursor && result.pages < 500);
      result.detail = `${result.pages} page(s) parcourue(s)`;
    }
  }
  await ctx.db.query(
    `UPDATE sync_runs SET status='DONE', pages=$2, fetched=$3, new_events=$4, duplicates=$5, reprocessed=$6, detail=$7, finished_at=now() WHERE id=$1`,
    [sync!.id, result.pages, result.fetched, result.newEvents, result.duplicates, reprocessed, result.detail],
  );
  await ctx.db.query('UPDATE provider_connections SET last_sync_at=now() WHERE id=$1', [connectionId]);
  return result;
}
