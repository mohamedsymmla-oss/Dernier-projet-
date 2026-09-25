import crypto from 'node:crypto';
import {
  ProviderError,
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
} from './types.js';
import { SendZenConnector } from './sendzen/connector.js';
import { parseSendZenWebhook, verifySendZenSignature } from './sendzen/webhook.js';

export interface FakeSend {
  to: string;
  message: OutboundMessage;
  at: number;
  providerMessageId: string;
}

/**
 * Connecteur de test (utilisé uniquement par les tests automatisés).
 * Jamais proposé dans l'interface : il n'est pas enregistré dans le registre de production.
 */
export class FakeConnector implements ProviderConnector {
  readonly id = 'sendzen' as const;
  readonly displayName = 'Fake (tests)';
  sends: FakeSend[] = [];
  /** File d'erreurs à lever lors des prochains envois (FIFO). */
  failures: Array<ProviderError | ((to: string, m: OutboundMessage) => ProviderError | null)> = [];
  logsPages: LogsPage[] = [];
  now: () => number = () => Date.now();
  sendDurationMs = 0;
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  webhookSecret: string | null = 'test-secret';

  capabilities(): ProviderCapabilities {
    return { ...SendZenConnector.capabilities(), fetchLogs: { status: 'SUPPORTED', note: 'fake' } };
  }

  async testAuth() {
    return { ok: true as const };
  }

  async getPhoneNumbers(): Promise<ProviderPhoneNumber[]> {
    return [
      {
        projectId: '1',
        projectName: 'Projet test',
        wabaId: 'waba-1',
        wabaName: 'Business test',
        phoneNumberId: 'pn-1',
        phoneNumber: '+22370000000',
        status: 'CONNECTED',
        isConnected: true,
        raw: {},
      },
    ];
  }

  async send(_sender: SenderIdentity, to: string, message: OutboundMessage): Promise<SendResult> {
    if (this.sendDurationMs) await this.sleep(this.sendDurationMs);
    const next = this.failures.shift();
    if (next) {
      const err = typeof next === 'function' ? next(to, message) : next;
      if (err) throw err;
    }
    const providerMessageId = 'wamid.' + crypto.randomUUID();
    this.sends.push({ to, message, at: this.now(), providerMessageId });
    return { providerMessageId, providerStatus: 'queued', httpStatus: 200, requestId: 'req-' + this.sends.length, raw: {} };
  }

  async listTemplates(): Promise<ProviderTemplate[]> {
    return [{ id: 't1', name: 'relance', language: 'fr', status: 'APPROVED', category: 'MARKETING', variableCount: 0, raw: {} }];
  }

  verifyWebhook(req: WebhookRequest): WebhookVerification {
    return verifySendZenSignature(req, this.webhookSecret);
  }

  parseWebhook(payload: unknown, rawBody: Buffer): NormalizedEvent[] {
    return parseSendZenWebhook(payload, rawBody);
  }

  async fetchLogs(params: { since: Date; cursor?: string | null }): Promise<LogsPage> {
    const idx = params.cursor ? Number(params.cursor) : 0;
    const page = this.logsPages[idx];
    if (!page) return { events: [], nextCursor: null };
    return { events: page.events, nextCursor: idx + 1 < this.logsPages.length ? String(idx + 1) : null };
  }
}

export function transientError(msg = 'Timeout') {
  return new ProviderError('TRANSIENT', msg, { httpStatus: 503 });
}
export function rateLimitError(retryAfterMs = 1000) {
  return new ProviderError('RATE_LIMITED', 'Too many requests', { httpStatus: 429, retryAfterMs });
}
export function permanentError(kind: 'INVALID_RECIPIENT' | 'INVALID_MEDIA' | 'AUTH' | 'WINDOW_CLOSED' = 'INVALID_RECIPIENT') {
  return new ProviderError(kind, 'Erreur définitive (' + kind + ')', { httpStatus: kind === 'AUTH' ? 401 : 400 });
}
