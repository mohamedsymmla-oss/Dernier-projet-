import { ProviderError, type HttpObserver, type ProviderId } from './types.js';

export interface HttpRequestOptions {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  json: unknown;
  text: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Petit client HTTP avec timeout et observateur (journal technique). N'enregistre jamais les en-têtes d'authentification. */
export async function httpRequest(
  provider: ProviderId,
  opts: HttpRequestOptions,
  observer: HttpObserver | undefined,
  fetchImpl: FetchLike = fetch,
  extractMessageId?: (json: unknown) => string | null,
): Promise<HttpResponse> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  const endpoint = new URL(opts.url).pathname;
  let status: number | null = null;
  let requestId: string | null = null;
  let text = '';
  let errorMsg: string | null = null;
  let json: unknown = null;
  try {
    const res = await fetchImpl(opts.url, {
      method: opts.method,
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    status = res.status;
    requestId = res.headers.get('x-request-id') ?? res.headers.get('request-id') ?? null;
    text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (status >= 400) errorMsg = summarizeError(json, text);
    return { status, headers: res.headers, json, text };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    errorMsg = aborted ? 'Délai dépassé (timeout)' : `Erreur réseau : ${(err as Error).message}`;
    throw new ProviderError('TRANSIENT', errorMsg, { raw: String(err) });
  } finally {
    clearTimeout(timer);
    await Promise.resolve(
      observer?.({
        provider,
        method: opts.method,
        endpoint,
        httpStatus: status,
        requestId,
        providerMessageId: extractMessageId && json ? safe(() => extractMessageId(json)) : null,
        durationMs: Date.now() - started,
        error: errorMsg,
        responseSnippet: text ? text.slice(0, 2000) : null,
      }),
    ).catch(() => undefined);
  }
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export function summarizeError(json: unknown, text: string): string {
  if (json && typeof json === 'object') {
    const j = json as Record<string, any>;
    const parts = [j.message, j.error?.details, j.error?.message, j.error?.code].filter(
      (x) => typeof x === 'string' && x.length > 0,
    );
    if (parts.length) return parts.join(' — ');
  }
  return text.slice(0, 300) || 'Erreur inconnue';
}

export function parseRetryAfter(headers: Headers): number | null {
  const v = headers.get('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
