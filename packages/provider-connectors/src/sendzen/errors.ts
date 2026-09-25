import { ProviderError, type ProviderErrorKind } from '../types.js';

/**
 * Codes d'erreur WhatsApp Cloud API (SendZen relaie l'API officielle Meta).
 * Utilisés pour classer une erreur en temporaire ou définitive.
 */
const WINDOW_CODES = new Set(['131047', '470']); // Re-engagement : hors fenêtre de 24 h
const RATE_CODES = new Set(['4', '80007', '130429', '131048', '131056']);
const RECIPIENT_CODES = new Set(['131026', '131030', '131021', '1013']);
const MEDIA_CODES = new Set(['131051', '131052', '131053']);
const AUTH_CODES = new Set(['190', '0', '10', '200', '131031', '131005']);
const TRANSIENT_CODES = new Set(['1', '2', '131000', '131016', '133004']);

export function classifyByCode(code: string | null | undefined): ProviderErrorKind | null {
  if (!code) return null;
  if (WINDOW_CODES.has(code)) return 'WINDOW_CLOSED';
  if (RATE_CODES.has(code)) return 'RATE_LIMITED';
  if (RECIPIENT_CODES.has(code)) return 'INVALID_RECIPIENT';
  if (MEDIA_CODES.has(code)) return 'INVALID_MEDIA';
  if (AUTH_CODES.has(code)) return 'AUTH';
  if (TRANSIENT_CODES.has(code)) return 'TRANSIENT';
  return null;
}

export function classifyHttpError(
  httpStatus: number,
  json: unknown,
  message: string,
  retryAfterMs: number | null,
  requestId: string | null,
): ProviderError {
  const code = extractCode(json);
  const text = message.toLowerCase();
  let kind: ProviderErrorKind;
  const byCode = classifyByCode(code);
  if (httpStatus === 429) kind = 'RATE_LIMITED';
  else if (byCode) kind = byCode;
  else if (httpStatus === 401 || httpStatus === 403) kind = 'AUTH';
  else if (httpStatus >= 500 || httpStatus === 408) kind = 'TRANSIENT';
  else if (/24.?hour|re-?engagement|outside.*window|customer care window/.test(text)) kind = 'WINDOW_CLOSED';
  else if (/rate.?limit|too many/.test(text)) kind = 'RATE_LIMITED';
  else if (/media|file|download|mime|format/.test(text)) kind = 'INVALID_MEDIA';
  else if (/phone|recipient|number|to\b/.test(text)) kind = 'INVALID_RECIPIENT';
  else kind = 'PERMANENT';
  return new ProviderError(kind, message, { httpStatus, code, retryAfterMs, requestId, raw: json });
}

function extractCode(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, any>;
  const candidates = [j.error?.code, j.code, j.error?.error_data?.code, j.errors?.[0]?.code];
  for (const c of candidates) {
    if (c !== undefined && c !== null && String(c).length) return String(c);
  }
  return null;
}
