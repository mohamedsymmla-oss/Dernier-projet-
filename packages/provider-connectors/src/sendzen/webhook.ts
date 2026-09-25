import crypto from 'node:crypto';
import type { NormalizedEvent, WebhookRequest, WebhookVerification } from '../types.js';
import { SENDZEN_SIGNATURE_HEADER } from './endpoints.js';

export function verifySendZenSignature(req: WebhookRequest, secret: string | null | undefined): WebhookVerification {
  const header = req.headers[SENDZEN_SIGNATURE_HEADER];
  const sig = Array.isArray(header) ? header[0] : header;
  if (!secret) {
    return { verified: false, reason: 'Secret webhook non configuré', signaturePresent: typeof sig === 'string' };
  }
  if (typeof sig !== 'string' || !sig.startsWith('sha256=')) {
    return { verified: false, reason: 'En-tête X-Hub-Signature-256 absent ou invalide', signaturePresent: false };
  }
  const provided = sig.slice('sha256='.length).trim();
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  if (!/^[0-9a-f]+$/i.test(provided) || provided.length !== expected.length) {
    return { verified: false, reason: 'Signature invalide', signaturePresent: true };
  }
  const ok = crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  return ok
    ? { verified: true, method: 'HMAC-SHA256 (X-Hub-Signature-256)' }
    : { verified: false, reason: 'Signature invalide', signaturePresent: true };
}

export function signSendZenPayload(rawBody: Buffer | string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

const STATUS_MAP: Record<string, 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'> = {
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  played: 'READ',
  failed: 'FAILED',
  undelivered: 'FAILED',
};

function toE164(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const digits = String(v).replace(/[^\d]/g, '');
  return digits ? '+' + digits : null;
}

function toDate(v: unknown): Date {
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
    const n = Number(v);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function extractText(m: Record<string, any>): string | null {
  if (m.text?.body) return String(m.text.body);
  if (m.button?.text) return String(m.button.text);
  if (m.interactive?.button_reply?.title) return String(m.interactive.button_reply.title);
  if (m.interactive?.list_reply?.title) return String(m.interactive.list_reply.title);
  for (const k of ['image', 'video', 'document', 'audio']) if (m[k]?.caption) return String(m[k].caption);
  return null;
}

export function hashPayload(raw: Buffer | string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * SendZen relaie le format de webhook de la WhatsApp Cloud API
 * (object / entry[] / changes[] / value.{metadata, messages, statuses}).
 * Tout ce qui n'est pas reconnu est conservé comme événement « other » (jamais perdu).
 */
export function parseSendZenWebhook(payload: unknown, rawBody: Buffer): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const p = (payload ?? {}) as Record<string, any>;
  const values: Record<string, any>[] = [];
  if (Array.isArray(p.entry)) {
    for (const entry of p.entry) for (const ch of entry?.changes ?? []) if (ch?.value) values.push(ch.value);
  } else if (p.value && typeof p.value === 'object') {
    values.push(p.value);
  } else if (Array.isArray(p.messages) || Array.isArray(p.statuses)) {
    values.push(p);
  }

  for (const v of values) {
    const phoneNumberId = v.metadata?.phone_number_id ? String(v.metadata.phone_number_id) : null;
    const displayPhone = toE164(v.metadata?.display_phone_number);
    for (const m of v.messages ?? []) {
      if (!m?.id) continue;
      events.push({
        type: 'inbound_message',
        dedupeKey: `sendzen:in:${m.id}`,
        providerMessageId: String(m.id),
        from: toE164(m.from) ?? 'inconnu',
        toPhoneNumberId: phoneNumberId,
        toPhoneNumber: displayPhone,
        messageType: String(m.type ?? 'unknown'),
        text: extractText(m),
        timestamp: toDate(m.timestamp),
        raw: m,
      });
    }
    for (const s of v.statuses ?? []) {
      const status = STATUS_MAP[String(s?.status ?? '').toLowerCase()];
      if (!s?.id || !status) continue;
      const err = s.errors?.[0];
      events.push({
        type: 'message_status',
        dedupeKey: `sendzen:st:${s.id}:${status}`,
        providerMessageId: String(s.id),
        status,
        recipient: toE164(s.recipient_id),
        timestamp: toDate(s.timestamp),
        errorCode: err?.code !== undefined ? String(err.code) : null,
        errorMessage: err ? String(err.message ?? err.title ?? err.error_data?.details ?? '') || null : null,
        raw: s,
      });
    }
  }

  if (events.length === 0) {
    events.push({
      type: 'other',
      dedupeKey: `sendzen:other:${hashPayload(rawBody)}`,
      name: String(p.event ?? p.type ?? p.field ?? p.object ?? 'unknown'),
      timestamp: new Date(),
      raw: payload,
    });
  }
  return events;
}
