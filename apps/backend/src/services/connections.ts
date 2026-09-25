import { PROVIDERS, toProviderError, type ProviderId, type ProviderPhoneNumber } from '@wa/provider-connectors';
import { normalizePhone } from '@wa/shared';
import { many, one, withTx } from '../db/pool.js';
import type { AppContext, ConnectionRow } from '../context.js';
import { maskSecret } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from './audit.js';
import { buildOutbound } from './engine.js';
import { upsertContact } from './runs.js';

export type CheckStatus = 'ok' | 'warning' | 'error' | 'unavailable' | 'skipped';
export interface Check {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export function webhookUrl(ctx: AppContext, conn: { id: string; provider: string }) {
  const base = ctx.config.PUBLIC_BACKEND_URL?.replace(/\/+$/, '');
  return base ? `${base}/webhooks/${conn.provider}/${conn.id}` : null;
}

export function publicConnection(ctx: AppContext, c: any, isActive = false) {
  return {
    id: c.id,
    provider: c.provider,
    providerName: PROVIDERS.find((p) => p.id === c.provider)?.name ?? c.provider,
    label: c.label,
    mode: c.mode,
    status: c.status,
    statusDetail: c.status_detail,
    apiKeyHint: c.api_key_hint,
    hasApiKey: !!c.api_key_enc,
    webhookSecretHint: c.webhook_secret_hint,
    hasWebhookSecret: !!c.webhook_secret_enc,
    apiBaseUrl: c.api_base_url,
    projectId: c.project_id,
    projectName: c.project_name,
    wabaId: c.waba_id,
    wabaName: c.waba_name,
    phoneNumberId: c.phone_number_id,
    phoneNumber: c.phone_number,
    numberStatus: c.number_status,
    webhookUrl: webhookUrl(ctx, c),
    lastTestAt: c.last_test_at,
    lastTestResult: c.last_test_result,
    lastWebhookAt: c.last_webhook_at,
    lastWebhookVerified: c.last_webhook_verified,
    lastSyncAt: c.last_sync_at,
    isActive,
    createdAt: c.created_at,
    disconnectedAt: c.disconnected_at,
  };
}

export async function listConnections(ctx: AppContext) {
  const s = await one(ctx.db, 'SELECT active_connection_id FROM app_settings WHERE id=1');
  const rows = await many(ctx.db, 'SELECT * FROM provider_connections ORDER BY created_at DESC');
  return rows.map((r) => publicConnection(ctx, r, r.id === s?.active_connection_id));
}

async function getConn(ctx: AppContext, id: string) {
  const c = await one<ConnectionRow>(ctx.db, 'SELECT * FROM provider_connections WHERE id=$1', [id]);
  if (!c) throw notFound('Connexion');
  return c;
}

/**
 * Connecter : la clé est vérifiée auprès du fournisseur AVANT d'être enregistrée (chiffrée).
 * Retourne les numéros disponibles pour sélection.
 */
export async function createConnection(
  ctx: AppContext,
  input: { provider: ProviderId; label: string; mode: 'PRODUCTION' | 'TEST'; apiKey: string; webhookSecret?: string | null; apiBaseUrl?: string | null },
  userId?: string | null,
) {
  if (!PROVIDERS.some((p) => p.id === input.provider)) throw badRequest('Fournisseur non développé');
  const probe = ctx.connectorFor({
    id: 'probe',
    provider: input.provider,
    label: input.label,
    mode: input.mode,
    status: 'UNVERIFIED',
    api_key_enc: ctx.secrets.encrypt(input.apiKey),
    webhook_secret_enc: null,
    api_base_url: input.apiBaseUrl ?? null,
    phone_number: null,
    phone_number_id: null,
    waba_id: null,
  });
  const auth = await probe.testAuth();
  if (!auth.ok) throw badRequest(`Clé API refusée par le fournisseur : ${auth.error.message}`);
  let numbers: ProviderPhoneNumber[] = [];
  try {
    numbers = await probe.getPhoneNumbers();
  } catch (e) {
    throw badRequest(`Impossible de lire les numéros : ${toProviderError(e).message}`);
  }

  const row = await withTx(ctx.db, async (tx) => {
    const r = await one(
      tx,
      `INSERT INTO provider_connections (provider, label, mode, status, status_detail, api_key_enc, api_key_hint,
          webhook_secret_enc, webhook_secret_hint, api_base_url)
       VALUES ($1,$2,$3,'UNVERIFIED','Clé valide : sélectionnez un numéro',$4,$5,$6,$7,$8) RETURNING *`,
      [
        input.provider,
        input.label,
        input.mode,
        ctx.secrets.encrypt(input.apiKey),
        maskSecret(input.apiKey),
        input.webhookSecret ? ctx.secrets.encrypt(input.webhookSecret) : null,
        input.webhookSecret ? maskSecret(input.webhookSecret) : null,
        input.apiBaseUrl ?? null,
      ],
    );
    await audit(tx, 'connection.created', { userId, entityType: 'provider_connection', entityId: r.id, details: { provider: input.provider, mode: input.mode } });
    return r;
  });
  if (numbers.length === 1) {
    await selectNumber(ctx, row.id, numbers[0]!.phoneNumberId, userId);
  }
  const fresh = await getConn(ctx, row.id);
  const s = await one(ctx.db, 'SELECT active_connection_id FROM app_settings WHERE id=1');
  return { connection: publicConnection(ctx, fresh, s?.active_connection_id === row.id), numbers: numbers.map(publicNumber) };
}

function publicNumber(n: ProviderPhoneNumber) {
  return {
    projectId: n.projectId,
    projectName: n.projectName,
    wabaId: n.wabaId,
    wabaName: n.wabaName,
    phoneNumberId: n.phoneNumberId,
    phoneNumber: n.phoneNumber,
    status: n.status,
    isConnected: n.isConnected,
  };
}

export async function listProviderNumbers(ctx: AppContext, id: string) {
  const conn = await getConn(ctx, id);
  if (!conn.api_key_enc) throw badRequest('Connexion sans clé API');
  return (await ctx.connectorFor(conn).getPhoneNumbers()).map(publicNumber);
}

/** Choisit le numéro WhatsApp et rend cette connexion active. L'historique des numéros est conservé. */
export async function selectNumber(ctx: AppContext, id: string, phoneNumberId: string, userId?: string | null) {
  const conn = await getConn(ctx, id);
  const numbers = await ctx.connectorFor(conn).getPhoneNumbers();
  const n = numbers.find((x) => x.phoneNumberId === phoneNumberId);
  if (!n) throw badRequest('Numéro introuvable pour cette clé API');
  await withTx(ctx.db, async (tx) => {
    await tx.query(
      `UPDATE provider_connections SET project_id=$2, project_name=$3, waba_id=$4, waba_name=$5, phone_number_id=$6,
          phone_number=$7, number_status=$8, status=$9, status_detail=$10, disconnected_at=NULL, updated_at=now() WHERE id=$1`,
      [
        id,
        n.projectId,
        n.projectName,
        n.wabaId,
        n.wabaName,
        n.phoneNumberId,
        n.phoneNumber,
        n.status,
        n.isConnected ? 'CONNECTED' : 'ERROR',
        n.isConnected ? 'Clé valide et numéro connecté' : `Numéro non connecté chez le fournisseur (statut ${n.status})`,
      ],
    );
    await tx.query(
      `INSERT INTO whatsapp_numbers (phone_e164, provider, phone_number_id, waba_id, project_id, status, last_connection_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (phone_e164) DO UPDATE SET phone_number_id=EXCLUDED.phone_number_id, waba_id=EXCLUDED.waba_id,
         project_id=EXCLUDED.project_id, status=EXCLUDED.status, last_connection_id=EXCLUDED.last_connection_id, last_seen_at=now()`,
      [n.phoneNumber, conn.provider, n.phoneNumberId, n.wabaId, n.projectId, n.status, id],
    );
    await tx.query('UPDATE app_settings SET active_connection_id=$1, updated_at=now() WHERE id=1', [id]);
    await audit(tx, 'connection.number_selected', { userId, entityType: 'provider_connection', entityId: id, details: { phone: n.phoneNumber } });
  });
  return publicConnection(ctx, await getConn(ctx, id), true);
}

export async function updateConnection(
  ctx: AppContext,
  id: string,
  input: { label?: string; apiKey?: string; webhookSecret?: string | null; apiBaseUrl?: string | null },
  userId?: string | null,
) {
  const conn = await getConn(ctx, id);
  if (input.apiKey) {
    const probe = ctx.connectorFor({ ...conn, api_key_enc: ctx.secrets.encrypt(input.apiKey), api_base_url: input.apiBaseUrl ?? conn.api_base_url });
    const auth = await probe.testAuth();
    if (!auth.ok) throw badRequest(`Nouvelle clé refusée : ${auth.error.message}`);
  }
  const sets: string[] = [];
  const params: unknown[] = [id];
  const add = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col}=$${params.length}`);
  };
  if (input.label !== undefined) add('label', input.label);
  if (input.apiKey) {
    add('api_key_enc', ctx.secrets.encrypt(input.apiKey));
    add('api_key_hint', maskSecret(input.apiKey));
    if (conn.status === 'DISCONNECTED') add('status', 'UNVERIFIED');
  }
  if (input.webhookSecret !== undefined) {
    add('webhook_secret_enc', input.webhookSecret ? ctx.secrets.encrypt(input.webhookSecret) : null);
    add('webhook_secret_hint', input.webhookSecret ? maskSecret(input.webhookSecret) : null);
  }
  if (input.apiBaseUrl !== undefined) add('api_base_url', input.apiBaseUrl || null);
  if (sets.length === 0) return publicConnection(ctx, conn);
  await ctx.db.query(`UPDATE provider_connections SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, params);
  await audit(ctx.db, 'connection.updated', {
    userId,
    entityType: 'provider_connection',
    entityId: id,
    details: { fields: Object.keys(input).filter((k) => (input as any)[k] !== undefined) },
  });
  return publicConnection(ctx, await getConn(ctx, id));
}

/** Déconnecter : la clé est effacée, mais tout l'historique (contacts, campagnes, messages) est conservé. */
export async function disconnect(ctx: AppContext, id: string, userId?: string | null) {
  await withTx(ctx.db, async (tx) => {
    await tx.query(
      `UPDATE provider_connections SET status='DISCONNECTED', status_detail='Déconnecté manuellement', api_key_enc=NULL,
          webhook_secret_enc=NULL, disconnected_at=now(), updated_at=now() WHERE id=$1`,
      [id],
    );
    await tx.query(
      `UPDATE automation_runs SET status='PAUSED', paused_at=now(), pause_reason='Connexion déconnectée' WHERE connection_id=$1 AND status='RUNNING'`,
      [id],
    );
    await audit(tx, 'connection.disconnected', { userId, entityType: 'provider_connection', entityId: id });
  });
  return publicConnection(ctx, await getConn(ctx, id));
}

/** TESTER LA CONNEXION : vérifications réelles et indépendantes. Rien n'est affiché « OK » sans preuve. */
export async function testConnection(ctx: AppContext, id: string, opts: { sendTestMessage?: boolean } = {}) {
  const conn = await getConn(ctx, id);
  const checks: Check[] = [];
  const push = (key: string, label: string, status: CheckStatus, detail: string) => checks.push({ key, label, status, detail });

  push('backend', 'Backend', 'ok', 'En ligne');
  try {
    await ctx.db.query('SELECT 1');
    push('database', 'Base de données', 'ok', 'PostgreSQL accessible');
  } catch (e) {
    push('database', 'Base de données', 'error', (e as Error).message);
  }
  if (ctx.redis) {
    try {
      await ctx.redis.ping();
      push('redis', "File d'attente (Redis)", 'ok', 'Redis accessible');
    } catch (e) {
      push('redis', "File d'attente (Redis)", 'error', (e as Error).message);
    }
  }

  if (!conn.api_key_enc) {
    push('api', 'API fournisseur', 'error', 'Aucune clé API (connexion déconnectée)');
    return saveTest(ctx, conn, checks, false);
  }
  const connector = ctx.connectorFor(conn);
  const caps = connector.capabilities();
  const auth = await connector.testAuth();
  if (!auth.ok) {
    push('api', `API ${connector.displayName}`, 'error', `Authentification refusée : ${auth.error.message}`);
    return saveTest(ctx, conn, checks, false);
  }
  push('api', `API ${connector.displayName}`, 'ok', 'Authentification valide');

  let numbers: ProviderPhoneNumber[] = [];
  try {
    numbers = await connector.getPhoneNumbers();
  } catch (e) {
    push('project', 'Projet', 'error', toProviderError(e).message);
    return saveTest(ctx, conn, checks, false);
  }
  const project = numbers.find((n) => n.projectId === conn.project_id);
  push('project', 'Projet', project ? 'ok' : numbers.length ? 'warning' : 'error',
    project ? `Accessible : ${project.projectName}` : numbers.length ? 'Projet enregistré introuvable : resélectionnez le numéro' : 'Aucun projet accessible');
  const waba = numbers.find((n) => n.wabaId === conn.waba_id);
  push('waba', 'WABA', waba ? 'ok' : 'error', waba ? `Détecté : ${waba.wabaId}${waba.wabaName ? ' (' + waba.wabaName + ')' : ''}` : 'WABA non trouvé');
  const number = numbers.find((n) => n.phoneNumberId === conn.phone_number_id);
  const numberOk = !!number && number.isConnected;
  push('number', 'Numéro WhatsApp', numberOk ? 'ok' : 'error',
    number ? `${number.phoneNumber} — statut fournisseur : ${number.status}` : 'Numéro non trouvé : sélectionnez un numéro');
  if (number) {
    await ctx.db.query('UPDATE provider_connections SET number_status=$2 WHERE id=$1', [id, number.status]);
  }

  const url = webhookUrl(ctx, conn);
  push('webhook_config', 'Webhook configuré chez le fournisseur',
    caps.webhookConfigCheck.status === 'NOT_AVAILABLE' ? 'unavailable' : 'ok',
    caps.webhookConfigCheck.status === 'NOT_AVAILABLE'
      ? `Non vérifiable par API. Vérifiez dans SendZen que l'URL est : ${url ?? 'PUBLIC_BACKEND_URL non défini'}`
      : 'Configuré');
  if (!url) push('webhook_url', 'URL publique du webhook', 'error', 'PUBLIC_BACKEND_URL non défini sur le serveur');
  push('webhook_signature', 'Signature webhook', conn.webhook_secret_enc ? 'ok' : 'warning',
    conn.webhook_secret_enc ? 'Secret configuré : signatures vérifiées (HMAC-SHA256)' : 'Aucun secret : les webhooks ne sont pas authentifiés');

  const last = conn.last_webhook_at as Date | null;
  if (last) {
    const ageH = (Date.now() - new Date(last).getTime()) / 3600_000;
    push('webhook_reception', 'Réception webhook', ageH < 72 ? 'ok' : 'warning',
      `Dernier webhook reçu ${ageH < 1 ? 'il y a moins d’une heure' : `il y a ${Math.round(ageH)} h`}${conn.last_webhook_verified ? ' (signature vérifiée)' : ''}`);
  } else {
    push('webhook_reception', 'Réception webhook', 'warning', 'Aucun webhook reçu pour le moment : envoyez un message WhatsApp à votre numéro puis relancez le test');
  }

  if (opts.sendTestMessage) {
    const s = await one(ctx.db, 'SELECT test_phone_e164 FROM app_settings WHERE id=1');
    if (!s?.test_phone_e164) {
      push('send', 'Envoi API', 'skipped', 'Définissez un numéro de test dans Réglages');
    } else {
      const r = await sendDirectTest(ctx, conn, s.test_phone_e164, { kind: 'text', text: `✅ Test de connexion ${new Date().toLocaleString('fr-FR')}` });
      push('send', 'Envoi API', r.ok ? 'ok' : 'error',
        r.ok ? `Accepté par l'API (id ${r.providerMessageId}). Livraison confirmée uniquement par webhook.` : r.error!);
    }
  } else {
    push('send', 'Envoi API', 'skipped', 'Non testé : cochez « Envoyer un message de test »');
  }

  return saveTest(ctx, conn, checks, !!auth.ok && numberOk);
}

async function saveTest(ctx: AppContext, conn: ConnectionRow, checks: Check[], connected: boolean) {
  const status = conn.status === 'DISCONNECTED' ? 'DISCONNECTED' : connected ? 'CONNECTED' : 'ERROR';
  const failed = checks.filter((c) => c.status === 'error').map((c) => c.label);
  await ctx.db.query(
    `UPDATE provider_connections SET last_test_at=now(), last_test_result=$2, status=$3, status_detail=$4, updated_at=now() WHERE id=$1`,
    [conn.id, JSON.stringify(checks), status, connected ? 'Vérifié : clé valide et numéro connecté' : `Problème : ${failed.join(', ') || 'voir le test'}`],
  );
  return { connected, status, checks, testedAt: new Date().toISOString() };
}

/** Envoi unitaire vers le numéro de test (outil de test média / connexion). Enregistré dans l'historique comme test. */
export async function sendDirectTest(
  ctx: AppContext,
  conn: ConnectionRow,
  phone: string,
  item: { kind: 'text'; text: string } | { kind: 'audio' | 'image'; mediaId: string },
) {
  const n = normalizePhone(phone);
  if (!n.ok) return { ok: false, error: 'Numéro de test invalide' };
  const contact = await upsertContact(ctx, n.e164);
  const msg = await buildOutbound(ctx, {
    kind: item.kind,
    media_id: item.kind === 'text' ? null : item.mediaId,
    text_body: item.kind === 'text' ? item.text : null,
    template: null,
  }).catch((e) => ({ error: (e as Error).message }));
  if ('error' in msg) return { ok: false, error: msg.error };
  const o = await one(
    ctx.db,
    `INSERT INTO outbound_messages (connection_id, provider, contact_id, to_phone, kind, is_test, status, submitted_at)
     VALUES ($1,$2,$3,$4,$5,true,'SUBMITTING',now()) RETURNING id`,
    [conn.id, conn.provider, contact.id, n.e164, item.kind],
  );
  try {
    const res = await ctx.connectorFor(conn).send(
      { phoneNumber: conn.phone_number ?? '', phoneNumberId: conn.phone_number_id ?? '', wabaId: conn.waba_id ?? '' },
      n.e164,
      msg,
    );
    await ctx.db.query(
      `UPDATE outbound_messages SET status='ACCEPTED', provider_message_id=$2, http_status=$3, request_id=$4, accepted_at=now() WHERE id=$1`,
      [o!.id, res.providerMessageId, res.httpStatus, res.requestId],
    );
    return { ok: true, providerMessageId: res.providerMessageId, outboundId: o!.id, deliveredAs: item.kind === 'audio' ? 'Audio standard' : item.kind };
  } catch (e) {
    const pe = toProviderError(e);
    await ctx.db.query(
      `UPDATE outbound_messages SET status='FAILED', failed_at=now(), error_code=$2, error_message=$3, http_status=$4 WHERE id=$1`,
      [o!.id, pe.details.code ?? pe.kind, pe.message, pe.details.httpStatus ?? null],
    );
    return { ok: false, error: pe.message, errorKind: pe.kind, outboundId: o!.id };
  }
}

export async function listTemplates(ctx: AppContext, id: string) {
  const conn = await getConn(ctx, id);
  if (!conn.waba_id) throw badRequest('Aucun WABA sélectionné');
  const list = await ctx.connectorFor(conn).listTemplates(conn.waba_id);
  return list.map((t) => ({
    id: t.id,
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category,
    variableCount: t.variableCount,
    usable: t.status === 'APPROVED' && t.variableCount === 0,
    reason:
      t.status !== 'APPROVED'
        ? 'Modèle non approuvé'
        : t.variableCount > 0
          ? 'Modèles avec variables : non pris en charge pour le moment'
          : null,
  }));
}
