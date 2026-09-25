import { httpRequest, parseRetryAfter, summarizeError, type FetchLike } from '../http.js';
import {
  ProviderError,
  type ConnectionCredentials,
  type HttpObserver,
  type LogsPage,
  type NormalizedEvent,
  type OutboundMessage,
  type ProviderCapabilities,
  type ProviderConnector,
  type ProviderPhoneNumber,
  type ProviderTemplate,
  type SendResult,
  type SenderIdentity,
  type WebhookRequest,
  type WebhookVerification,
} from '../types.js';
import { SENDZEN_DEFAULT_BASE_URL, SENDZEN_ENDPOINTS, SENDZEN_MEDIA_LIMITS } from './endpoints.js';
import { classifyHttpError } from './errors.js';
import { parseSendZenWebhook, verifySendZenSignature } from './webhook.js';

const CONNECTED_STATUSES = new Set(['CONNECTED', 'ACTIVE', 'LIVE', 'APPROVED', 'VERIFIED']);

export interface SendZenOptions {
  observer?: HttpObserver;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class SendZenConnector implements ProviderConnector {
  readonly id = 'sendzen' as const;
  readonly displayName = 'SendZen';
  private readonly baseUrl: string;

  constructor(
    private readonly creds: ConnectionCredentials,
    private readonly opts: SendZenOptions = {},
  ) {
    this.baseUrl = (creds.apiBaseUrl || SENDZEN_DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  static capabilities(): ProviderCapabilities {
    return {
      sendText: { status: 'SUPPORTED', note: 'POST /v1/messages type=text (nœud n8n officiel)' },
      sendAudio: {
        status: 'SUPPORTED',
        note: 'POST /v1/messages type=audio avec audio.link (SDK SendZen). Envoyé comme audio standard.',
      },
      sendVoiceNote: {
        status: 'NOT_AVAILABLE',
        note: "Aucun paramètre « message vocal / PTT » documenté par SendZen : l'audio est envoyé en audio standard.",
      },
      sendImage: { status: 'SUPPORTED', note: 'POST /v1/messages type=image avec image.link (SDK SendZen)' },
      sendTemplate: { status: 'SUPPORTED', note: 'POST /v1/messages type=template (nœud n8n officiel)' },
      listTemplates: { status: 'SUPPORTED', note: 'GET /v1/{wabaId}/message_templates' },
      listAccounts: { status: 'SUPPORTED', note: 'GET /v1/waba (projets, WABA, numéros)' },
      webhookSignature: { status: 'SUPPORTED', note: 'X-Hub-Signature-256 (HMAC-SHA256 du corps brut)' },
      fetchLogs: {
        status: 'NOT_AVAILABLE',
        note: "Endpoint de logs SendZen non confirmé : à configurer dans packages/provider-connectors/src/sendzen/endpoints.ts",
      },
      webhookConfigCheck: {
        status: 'NOT_AVAILABLE',
        note: "Aucun endpoint confirmé pour lire la configuration du webhook : à vérifier dans le tableau de bord SendZen",
      },
      partnerOnboarding: {
        status: 'NOT_AVAILABLE',
        note: 'Partner API / Embedded Onboarding : architecture prévue, endpoints à configurer avec une Partner API Key',
      },
      sandbox: {
        status: 'UNVERIFIED',
        note: "Mode TEST : utilise la clé et, si définie, l'URL d'API sandbox fournies. Données séparées de la production.",
      },
      audioFormats: SENDZEN_MEDIA_LIMITS.audioFormats,
      imageFormats: SENDZEN_MEDIA_LIMITS.imageFormats,
      maxAudioBytes: SENDZEN_MEDIA_LIMITS.maxAudioBytes,
      maxImageBytes: SENDZEN_MEDIA_LIMITS.maxImageBytes,
    };
  }

  capabilities(): ProviderCapabilities {
    return SendZenConnector.capabilities();
  }

  private headers() {
    return { Authorization: `Bearer ${this.creds.apiKey}` };
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await httpRequest(
      'sendzen',
      { method, url: this.baseUrl + path, headers: this.headers(), body, timeoutMs: this.opts.timeoutMs },
      this.opts.observer,
      this.opts.fetchImpl,
      extractMessageId,
    );
    if (res.status >= 400) {
      throw classifyHttpError(
        res.status,
        res.json,
        summarizeError(res.json, res.text),
        parseRetryAfter(res.headers),
        res.headers.get('x-request-id'),
      );
    }
    return res;
  }

  async testAuth() {
    try {
      await this.call('GET', SENDZEN_ENDPOINTS.authCheck);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: toProviderError(e) };
    }
  }

  async getPhoneNumbers(): Promise<ProviderPhoneNumber[]> {
    const res = await this.call('GET', SENDZEN_ENDPOINTS.wabaAccounts);
    const projects = (res.json as any)?.data?.projects;
    if (!Array.isArray(projects)) return [];
    const out: ProviderPhoneNumber[] = [];
    for (const project of projects) {
      for (const w of project?.wabas ?? []) {
        const phone = String(w.phone_number ?? '').replace(/[^\d+]/g, '');
        const status = String(w.number_status ?? 'UNKNOWN');
        out.push({
          projectId: String(project.id ?? ''),
          projectName: String(project.project_name ?? ''),
          wabaId: String(w.waba_id ?? ''),
          wabaName: w.waba_business_name ?? null,
          phoneNumberId: String(w.phone_number_id ?? ''),
          phoneNumber: phone.startsWith('+') ? phone : '+' + phone,
          status,
          isConnected: CONNECTED_STATUSES.has(status.toUpperCase()),
          raw: w,
        });
      }
    }
    return out;
  }

  /** Construit le corps de requête POST /v1/messages. Exporté pour les tests de non-régression. */
  static buildMessageBody(sender: SenderIdentity, to: string, message: OutboundMessage): Record<string, unknown> {
    const base = { from: sender.phoneNumber, to, type: message.kind } as Record<string, unknown>;
    switch (message.kind) {
      case 'text':
        return { ...base, text: { body: message.body, preview_url: message.previewUrl ?? false } };
      case 'audio':
        // Pas de paramètre « voice » : SendZen ne documente pas le PTT (voir capabilities).
        return { ...base, audio: { ...message.media } };
      case 'image':
        return { ...base, image: { ...message.media, ...(message.caption ? { caption: message.caption } : {}) } };
      case 'template':
        return {
          ...base,
          template: { name: message.name, lang_code: message.languageCode, components: message.components ?? [] },
        };
    }
  }

  async send(sender: SenderIdentity, to: string, message: OutboundMessage): Promise<SendResult> {
    if (message.kind === 'audio' && message.asVoiceNote) {
      throw new ProviderError('NOT_AVAILABLE', 'Message vocal (PTT) non disponible chez SendZen : utiliser l’audio standard');
    }
    const res = await this.call('POST', SENDZEN_ENDPOINTS.sendMessage, SendZenConnector.buildMessageBody(sender, to, message));
    const id = extractMessageId(res.json);
    if (!id) {
      throw new ProviderError('PERMANENT', "Réponse SendZen sans identifiant de message : envoi non confirmé", {
        httpStatus: res.status,
        raw: res.json,
      });
    }
    return {
      providerMessageId: id,
      providerStatus: extractStatus(res.json),
      httpStatus: res.status,
      requestId: res.headers.get('x-request-id'),
      raw: res.json,
    };
  }

  async listTemplates(wabaId: string): Promise<ProviderTemplate[]> {
    const res = await this.call('GET', SENDZEN_ENDPOINTS.templates(wabaId));
    const j = res.json as any;
    const list: any[] = j?.data?.data ?? j?.data ?? [];
    if (!Array.isArray(list)) return [];
    return list.map((t) => ({
      id: String(t.id),
      name: String(t.name),
      language: String(t.language),
      status: String(t.status),
      category: t.category ?? null,
      variableCount: countVariables(t.components),
      raw: t,
    }));
  }

  verifyWebhook(req: WebhookRequest): WebhookVerification {
    return verifySendZenSignature(req, this.creds.webhookSecret);
  }

  parseWebhook(payload: unknown, rawBody: Buffer): NormalizedEvent[] {
    return parseSendZenWebhook(payload, rawBody);
  }

  async fetchLogs(_params: { since: Date; cursor?: string | null }): Promise<LogsPage> {
    if (!SENDZEN_ENDPOINTS.logs) {
      throw new ProviderError('NOT_AVAILABLE', SendZenConnector.capabilities().fetchLogs.note);
    }
    throw new ProviderError('NOT_AVAILABLE', 'Parseur des logs SendZen à implémenter une fois le format confirmé');
  }
}

function countVariables(components: unknown): number {
  if (!Array.isArray(components)) return 0;
  let n = 0;
  for (const c of components as any[]) {
    const text = typeof c?.text === 'string' ? c.text : '';
    n += (text.match(/\{\{[^}]+\}\}/g) ?? []).length;
    if (c?.type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO'].includes(c?.format)) n += 1;
    for (const b of c?.buttons ?? []) if (typeof b?.url === 'string' && b.url.includes('{{')) n += 1;
  }
  return n;
}

/**
 * Réponse d'envoi SendZen : { message, data: [{ message_id, status, timestamp, to }] } (SDK SendZen).
 * On accepte aussi le format Cloud API { messages: [{ id }] } par robustesse.
 */
export function extractMessageId(json: unknown): string | null {
  const j = json as any;
  const candidates = [
    Array.isArray(j?.data) ? j.data[0]?.message_id : undefined,
    j?.data?.message_id,
    j?.data?.messages?.[0]?.id,
    j?.messages?.[0]?.id,
    j?.message_id,
  ];
  for (const c of candidates) if (typeof c === 'string' && c) return c;
  return null;
}

function extractStatus(json: unknown): string | null {
  const j = json as any;
  const s = Array.isArray(j?.data) ? j.data[0]?.status : j?.data?.status ?? j?.messages?.[0]?.message_status;
  return typeof s === 'string' ? s : null;
}

export function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  return new ProviderError('TRANSIENT', (e as Error)?.message ?? String(e));
}
