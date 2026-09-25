import { many, one } from '../db/pool.js';
import type { AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';

export interface HistoryFilters {
  automation?: 'A1' | 'A2';
  status?: string;
  result?: 'success' | 'failure';
  q?: string;
  from?: string;
  to?: string;
  provider?: string;
  mode?: 'PRODUCTION' | 'TEST';
  includeTests?: boolean;
  runId?: string;
  page?: number;
  pageSize?: number;
}

export async function listRecipients(ctx: AppContext, f: HistoryFilters) {
  const where: string[] = [];
  const p: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    p.push(v);
    where.push(sql.replace('?', `$${p.length}`));
  };
  if (f.automation) add('r.automation_type = ?', f.automation);
  if (f.status) add('r.status = ?', f.status);
  if (f.result === 'success') where.push(`r.status = 'COMPLETED' AND NOT r.delivery_failed`);
  if (f.result === 'failure') where.push(`(r.status IN ('FAILED','TEMPLATE_REQUIRED','NEEDS_REVIEW') OR r.delivery_failed)`);
  if (f.q) add(`r.phone_e164 LIKE '%' || ? || '%'`, f.q.replace(/[^\d+]/g, ''));
  if (f.from) add('r.created_at >= ?', f.from);
  if (f.to) add('r.created_at <= ?', f.to);
  if (f.provider) add('c.provider = ?', f.provider);
  if (f.mode) add('run.mode = ?', f.mode);
  if (f.runId) add('r.run_id = ?', f.runId);
  if (!f.includeTests && !f.runId) where.push(`run.kind <> 'TEST'`);
  const pageSize = Math.min(200, f.pageSize ?? 50);
  const page = Math.max(1, f.page ?? 1);
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await many(
    ctx.db,
    `SELECT r.id, r.run_id, r.contact_id, r.phone_e164, r.automation_type, r.status, r.position, r.delivery_failed,
            r.last_error, r.last_error_kind, r.started_at, r.completed_at, r.created_at, r.updated_at,
            run.kind AS run_kind, run.mode, c.provider,
            (SELECT json_agg(json_build_object('label', s.label, 'kind', s.kind, 'status', s.status,
                 'messageStatus', o.status, 'attempts', s.attempts, 'error', s.last_error) ORDER BY s.step_index)
               FROM automation_steps s LEFT JOIN outbound_messages o ON o.id = s.outbound_message_id
              WHERE s.recipient_id = r.id) AS steps
       FROM automation_recipients r
       JOIN automation_runs run ON run.id = r.run_id
       JOIN provider_connections c ON c.id = run.connection_id
       ${whereSql}
      ORDER BY r.updated_at DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    p,
  );
  const total = await one(
    ctx.db,
    `SELECT count(*)::int AS n FROM automation_recipients r JOIN automation_runs run ON run.id=r.run_id
       JOIN provider_connections c ON c.id = run.connection_id ${whereSql}`,
    p,
  );
  return { items: rows, total: total?.n ?? 0, page, pageSize };
}

/** Chronologie complète d'un contact (import, envois, statuts, réponses). */
export async function contactTimeline(ctx: AppContext, contactId: string) {
  const contact = await one(ctx.db, 'SELECT * FROM contacts WHERE id=$1', [contactId]);
  if (!contact) throw notFound('Contact');
  const events: Array<{ at: Date; type: string; label: string; detail?: string | null; status?: string; automation?: string }> = [];

  const imports = await many(
    ctx.db,
    `SELECT ci.created_at, ci.automation_type, ci.source FROM contact_import_items i JOIN contact_imports ci ON ci.id=i.import_id
      WHERE i.contact_id=$1 AND i.status='VALID' ORDER BY ci.created_at`,
    [contactId],
  );
  for (const i of imports) events.push({ at: i.created_at, type: 'import', label: 'Importé', detail: `Liste ${i.source}${i.automation_type ? ' — ' + i.automation_type : ''}` });

  const outs = await many(
    ctx.db,
    `SELECT o.*, s.label AS step_label, r.automation_type FROM outbound_messages o
       LEFT JOIN automation_steps s ON s.id=o.step_id LEFT JOIN automation_recipients r ON r.id=o.recipient_id
      WHERE o.contact_id=$1 ORDER BY o.created_at`,
    [contactId],
  );
  for (const o of outs) {
    const name = (o.step_label ?? o.kind) + (o.is_test ? ' (test)' : '');
    const auto = o.automation_type ?? undefined;
    if (o.submitted_at) events.push({ at: o.submitted_at, type: 'submitted', label: `${name} soumis`, automation: auto, detail: `tentative ${o.attempt}` });
    if (o.accepted_at) events.push({ at: o.accepted_at, type: 'accepted', label: `${name} accepté par l'API`, automation: auto, detail: o.provider_message_id });
    if (o.sent_at) events.push({ at: o.sent_at, type: 'sent', label: `${name} envoyé`, automation: auto });
    if (o.delivered_at) events.push({ at: o.delivered_at, type: 'delivered', label: `${name} livré`, automation: auto });
    if (o.read_at) events.push({ at: o.read_at, type: 'read', label: `${name} lu`, automation: auto });
    if (o.failed_at) events.push({ at: o.failed_at, type: 'failed', label: `${name} en échec`, automation: auto, detail: o.error_message, status: 'error' });
  }
  const ins = await many(ctx.db, 'SELECT * FROM inbound_messages WHERE contact_id=$1 ORDER BY received_at', [contactId]);
  for (const m of ins) events.push({ at: m.received_at, type: 'inbound', label: 'Client a répondu', detail: `${m.message_type}${m.text ? ' : ' + m.text.slice(0, 120) : ''}` });

  const recs = await many(
    ctx.db,
    `SELECT r.*, run.kind FROM automation_recipients r JOIN automation_runs run ON run.id=r.run_id WHERE r.contact_id=$1`,
    [contactId],
  );
  for (const r of recs) {
    if (r.status === 'TEMPLATE_REQUIRED') events.push({ at: r.updated_at, type: 'template_required', label: 'Modèle WhatsApp requis', detail: r.last_error, automation: r.automation_type, status: 'warning' });
    if (r.status === 'NEEDS_REVIEW') events.push({ at: r.updated_at, type: 'needs_review', label: 'Vérification requise', detail: r.last_error, automation: r.automation_type, status: 'warning' });
    if (r.status === 'COMPLETED' && r.completed_at) events.push({ at: r.completed_at, type: 'completed', label: `${r.automation_type === 'A1' ? 'Automation 1' : 'Automation 2'} terminée${r.kind === 'TEST' ? ' (test)' : ''}`, automation: r.automation_type });
  }
  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return { contact, events, recipients: recs };
}

export async function listContacts(ctx: AppContext, q: { q?: string; filter?: string; page?: number; pageSize?: number }) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.q) {
    p.push(q.q.replace(/[^\d+]/g, ''));
    where.push(`phone_e164 LIKE '%' || $${p.length} || '%'`);
  }
  const filters: Record<string, string> = {
    responded: 'responded_after_a1',
    a1_done: `a1_status='COMPLETED'`,
    a1_none: `a1_status='NONE'`,
    a2_done: `a2_status='COMPLETED'`,
    template_required: `(a1_status='TEMPLATE_REQUIRED' OR a2_status='TEMPLATE_REQUIRED')`,
    errors: 'last_error IS NOT NULL',
  };
  if (q.filter && filters[q.filter]) where.push(filters[q.filter]!);
  const pageSize = Math.min(200, q.pageSize ?? 50);
  const page = Math.max(1, q.page ?? 1);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const items = await many(ctx.db, `SELECT * FROM contacts ${w} ORDER BY updated_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, p);
  const total = await one(ctx.db, `SELECT count(*)::int AS n FROM contacts ${w}`, p);
  return { items, total: total?.n ?? 0, page, pageSize };
}

export async function dashboard(ctx: AppContext) {
  const settings = await one(ctx.db, 'SELECT * FROM app_settings WHERE id=1');
  const conn = settings?.active_connection_id
    ? await one(ctx.db, 'SELECT * FROM provider_connections WHERE id=$1', [settings.active_connection_id])
    : null;
  const a1 = await one(
    ctx.db,
    `SELECT count(*) FILTER (WHERE r.status='COMPLETED')::int AS completed, count(*)::int AS total
       FROM automation_recipients r JOIN automation_runs run ON run.id=r.run_id
      WHERE r.automation_type='A1' AND run.kind='SEQUENCE' AND run.mode=coalesce($1,'PRODUCTION')`,
    [conn?.mode ?? null],
  );
  const activeRuns = await many(ctx.db, `SELECT id, automation_type, kind, status FROM automation_runs WHERE status IN ('RUNNING','PAUSED') AND kind <> 'TEST'`);
  const a2Run = await one(
    ctx.db,
    `SELECT id, status, total FROM automation_runs WHERE automation_type='A2' AND kind='SEQUENCE' ORDER BY created_at DESC LIMIT 1`,
  );
  let a2 = null;
  if (a2Run) {
    const c = await one(
      ctx.db,
      `SELECT count(*) FILTER (WHERE status='COMPLETED')::int AS done, count(*) FILTER (WHERE status<>'CANCELLED')::int AS total
         FROM automation_recipients WHERE run_id=$1`,
      [a2Run.id],
    );
    a2 = { runId: a2Run.id, status: a2Run.status, done: c?.done ?? 0, total: c?.total ?? 0 };
  }
  const failures = await one(
    ctx.db,
    `SELECT count(*)::int AS n FROM automation_recipients r JOIN automation_runs run ON run.id=r.run_id
      WHERE run.kind <> 'TEST' AND (r.status IN ('FAILED','TEMPLATE_REQUIRED','NEEDS_REVIEW') OR r.delivery_failed)`,
  );
  const responses = await one(ctx.db, 'SELECT count(*)::int AS n FROM contacts WHERE responded_after_a1');
  const recentActivity = await many(
    ctx.db,
    `SELECT action, entity_type, entity_id, details, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 10`,
  );
  const recentErrors = await many(
    ctx.db,
    `SELECT o.to_phone, o.kind, o.error_code, o.error_message, o.failed_at AS at FROM outbound_messages o
      WHERE o.status='FAILED' ORDER BY o.failed_at DESC NULLS LAST LIMIT 10`,
  );
  const webhookOk = conn?.last_webhook_at && Date.now() - new Date(conn.last_webhook_at).getTime() < 72 * 3600_000;
  return {
    whatsapp: conn
      ? { status: conn.status, phoneNumber: conn.phone_number, numberStatus: conn.number_status, mode: conn.mode, detail: conn.status_detail }
      : { status: 'NOT_CONFIGURED', phoneNumber: null, numberStatus: null, mode: null, detail: 'À configurer' },
    provider: conn
      ? { name: conn.provider === 'sendzen' ? 'SendZen' : conn.provider, apiOk: conn.status === 'CONNECTED', lastTestAt: conn.last_test_at }
      : null,
    webhook: conn
      ? {
          status: webhookOk ? 'ok' : conn.last_webhook_at ? 'warning' : 'unknown',
          lastAt: conn.last_webhook_at,
          verified: conn.last_webhook_verified,
        }
      : null,
    automation1: { completed: a1?.completed ?? 0, total: a1?.total ?? 0 },
    automation2: a2,
    failures: failures?.n ?? 0,
    responses: responses?.n ?? 0,
    activeRuns,
    recentActivity,
    recentErrors,
  };
}
