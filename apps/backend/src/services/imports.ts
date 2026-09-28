import { analyzePhoneList, type AutomationType, type Channel } from '@wa/shared';
import { many, one, withTx } from '../db/pool.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/errors.js';
import { OCCUPYING_STATUSES, idempotencyKey } from './runs.js';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export async function createImport(
  ctx: AppContext,
  input: {
    automationType: AutomationType | null;
    source: 'paste' | 'csv' | 'txt';
    content: string;
    filename?: string | null;
    defaultCountry?: string | null;
    userId?: string | null;
    channel?: Channel;
  },
) {
  const channel: Channel = input.channel ?? 'PROVIDER';
  if (Buffer.byteLength(input.content, 'utf8') > MAX_IMPORT_BYTES) throw badRequest('Fichier trop volumineux (5 Mo maximum)');
  const settings = await one(ctx.db, 'SELECT default_country FROM app_settings WHERE id=1');
  const country = (input.defaultCountry || settings?.default_country || '').toUpperCase() || undefined;
  const lines = analyzePhoneList(input.content, input.source, country);
  if (lines.length === 0 || lines.every((l) => l.status === 'EMPTY')) throw badRequest('La liste est vide');

  const importId = await withTx(ctx.db, async (tx) => {
    const count = (s: string) => lines.filter((l) => l.status === s).length;
    const imp = await one(
      tx,
      `INSERT INTO contact_imports (automation_type, source, filename, default_country, total_lines, valid_count,
          invalid_count, duplicate_count, empty_count, created_by, channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        input.automationType,
        input.source,
        input.filename ?? null,
        country ?? null,
        lines.length,
        count('VALID'),
        count('INVALID'),
        count('DUPLICATE_IN_LIST'),
        count('EMPTY'),
        input.userId ?? null,
        channel,
      ],
    );
    const id = imp!.id as string;

    // Création des contacts (date d'ajout conservée : ON CONFLICT ne modifie pas un contact existant)
    const valid = lines.filter((l) => l.status === 'VALID').map((l) => l.e164!);
    for (let i = 0; i < valid.length; i += 1000) {
      const chunk = valid.slice(i, i + 1000);
      await tx.query(
        `INSERT INTO contacts (phone_e164, first_import_id) SELECT unnest($1::text[]), $2 ON CONFLICT (phone_e164) DO NOTHING`,
        [chunk, id],
      );
    }
    // Lignes d'import (toutes, y compris invalides et vides, avec la raison)
    for (let i = 0; i < lines.length; i += 1000) {
      const chunk = lines.slice(i, i + 1000);
      await tx.query(
        `INSERT INTO contact_import_items (import_id, line_number, raw_value, status, phone_e164, reason, contact_id)
         SELECT $1, t.line, t.raw, t.status, t.e164, t.reason, c.id
           FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[]) AS t(line, raw, status, e164, reason)
           LEFT JOIN contacts c ON c.phone_e164 = t.e164`,
        [
          id,
          chunk.map((l) => l.line),
          chunk.map((l) => l.raw.slice(0, 200)),
          chunk.map((l) => l.status),
          chunk.map((l) => l.e164 ?? null),
          chunk.map((l) => l.reason ?? null),
        ],
      );
    }
    return id;
  });
  return analyzeImport(ctx, importId, input.automationType);
}

/** Crée une liste Automation 2 à partir des personnes ayant répondu après Automation 1 (notre base, par canal). */
export async function createRespondersImport(ctx: AppContext, userId?: string | null, channel: Channel = 'PROVIDER') {
  const rows = await many(
    ctx.db,
    channel === 'QR'
      ? `SELECT c.id, c.phone_e164 FROM qr_contact_status q JOIN contacts c ON c.id=q.contact_id
          WHERE q.responded_after_a1 ORDER BY q.responded_after_a1_at`
      : `SELECT id, phone_e164 FROM contacts WHERE responded_after_a1 ORDER BY responded_after_a1_at`,
  );
  if (rows.length === 0) throw badRequest("Aucune réponse après Automation 1 n'a encore été enregistrée");
  const id = await withTx(ctx.db, async (tx) => {
    const imp = await one(
      tx,
      `INSERT INTO contact_imports (automation_type, source, total_lines, valid_count, created_by, channel)
       VALUES ('A2','responders',$1,$1,$2,$3) RETURNING id`,
      [rows.length, userId ?? null, channel],
    );
    await tx.query(
      `INSERT INTO contact_import_items (import_id, line_number, raw_value, status, phone_e164, contact_id)
       SELECT $1, t.n, t.phone, 'VALID', t.phone, t.cid FROM unnest($2::int[], $3::text[], $4::uuid[]) AS t(n, phone, cid)`,
      [imp!.id, rows.map((_, i) => i + 1), rows.map((r) => r.phone_e164), rows.map((r) => r.id)],
    );
    return imp!.id as string;
  });
  return analyzeImport(ctx, id, 'A2');
}

/**
 * Analyse avant lancement : rien n'est envoyé ici.
 * Numéros importés / valides / invalides / doublons / déjà automatisés / éligibles.
 */
export async function analyzeImport(ctx: AppContext, importId: string, type: AutomationType | null) {
  const imp = await one(ctx.db, 'SELECT * FROM contact_imports WHERE id=$1', [importId]);
  if (!imp) throw notFound('Import');
  const t = (type ?? imp.automation_type) as AutomationType | null;
  const channel = imp.channel as Channel;
  const conn =
    channel === 'QR'
      ? { mode: 'PRODUCTION' }
      : await one(
          ctx.db,
          'SELECT c.mode FROM app_settings s LEFT JOIN provider_connections c ON c.id=s.active_connection_id WHERE s.id=1',
        );
  const mode = conn?.mode ?? 'PRODUCTION';

  let already: any[] = [];
  let notResponded = 0;
  if (t) {
    already = await many(
      ctx.db,
      `SELECT i.line_number, i.phone_e164, r.status, r.run_id
         FROM contact_import_items i
         JOIN automation_recipients r ON r.idempotency_key = $2 || i.contact_id::text
        WHERE i.import_id=$1 AND i.status='VALID' AND r.status = ANY($3)
        ORDER BY i.line_number`,
      [importId, idempotencyKey(mode, 'SEQUENCE', t, '', channel), OCCUPYING_STATUSES],
    );
    if (t === 'A2') {
      const r = await one(
        ctx.db,
        channel === 'QR'
          ? `SELECT count(*)::int AS n FROM contact_import_items i LEFT JOIN qr_contact_status q ON q.contact_id=i.contact_id
              WHERE i.import_id=$1 AND i.status='VALID' AND NOT coalesce(q.responded_after_a1, false)`
          : `SELECT count(*)::int AS n FROM contact_import_items i JOIN contacts c ON c.id=i.contact_id
              WHERE i.import_id=$1 AND i.status='VALID' AND NOT c.responded_after_a1`,
        [importId],
      );
      notResponded = r?.n ?? 0;
    }
  }
  const issues = await many(
    ctx.db,
    `SELECT line_number, raw_value, status, phone_e164, reason FROM contact_import_items
      WHERE import_id=$1 AND status IN ('INVALID','DUPLICATE_IN_LIST') ORDER BY line_number LIMIT 500`,
    [importId],
  );
  const alreadyByStatus: Record<string, number> = {};
  for (const a of already) alreadyByStatus[a.status] = (alreadyByStatus[a.status] ?? 0) + 1;

  return {
    importId,
    automationType: t,
    channel,
    mode,
    source: imp.source,
    filename: imp.filename,
    defaultCountry: imp.default_country,
    counts: {
      imported: imp.total_lines - imp.empty_count,
      emptyLines: imp.empty_count,
      valid: imp.valid_count,
      invalid: imp.invalid_count,
      duplicatesInList: imp.duplicate_count,
      alreadyAutomated: already.length,
      eligible: imp.valid_count - already.length,
      notRespondedAfterA1: t === 'A2' ? notResponded : undefined,
    },
    alreadyByStatus,
    alreadyAutomated: already.slice(0, 200).map((a) => ({ line: a.line_number, phone: a.phone_e164, status: a.status })),
    issues: issues.map((i) => ({ line: i.line_number, raw: i.raw_value, status: i.status, phone: i.phone_e164, reason: i.reason })),
  };
}
