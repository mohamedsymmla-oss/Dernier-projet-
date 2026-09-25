import type { Redis } from 'ioredis';
import {
  createConnector,
  type HttpCallRecord,
  type ProviderConnector,
  type ProviderId,
} from '@wa/provider-connectors';
import type { AppConfig } from './config.js';
import type { Db } from './db/pool.js';
import type { Clock } from './lib/clock.js';
import type { SecretBox } from './lib/crypto.js';
import type { RateLimiter } from './lib/rate-limiter.js';
import type { Logger } from './logger.js';
import type { JobScheduler } from './queue/scheduler.js';
import type { MediaStorage } from './storage/storage.js';

export interface ConnectionRow {
  id: string;
  provider: ProviderId;
  label: string;
  mode: 'PRODUCTION' | 'TEST';
  status: string;
  api_key_enc: string | null;
  webhook_secret_enc: string | null;
  api_base_url: string | null;
  phone_number: string | null;
  phone_number_id: string | null;
  waba_id: string | null;
  [k: string]: unknown;
}

export interface LogContext {
  runId?: string | null;
  recipientId?: string | null;
  stepId?: string | null;
  attempt?: number | null;
}

export type ConnectorFactory = (conn: ConnectionRow, logCtx?: LogContext) => ProviderConnector;

export interface AppContext {
  config: AppConfig;
  db: Db;
  redis: Redis | null;
  log: Logger;
  secrets: SecretBox;
  clock: Clock;
  storage: MediaStorage;
  rateLimiter: RateLimiter;
  scheduler: JobScheduler;
  connectorFor: ConnectorFactory;
  ffmpegAvailable: boolean;
}

/** Fabrique de connecteurs de production : déchiffre les secrets et journalise chaque appel HTTP (sans secret). */
export function productionConnectorFactory(ctx: Omit<AppContext, 'connectorFor'>): ConnectorFactory {
  return (conn, logCtx = {}) => {
    if (!conn.api_key_enc) throw new Error('Clé API absente pour cette connexion');
    const apiKey = ctx.secrets.decrypt(conn.api_key_enc);
    const webhookSecret = conn.webhook_secret_enc ? ctx.secrets.decrypt(conn.webhook_secret_enc) : null;
    const defaultBase =
      conn.mode === 'TEST' ? ctx.config.SENDZEN_SANDBOX_API_BASE_URL ?? ctx.config.SENDZEN_API_BASE_URL : ctx.config.SENDZEN_API_BASE_URL;
    return createConnector(
      conn.provider,
      { apiKey, webhookSecret, apiBaseUrl: conn.api_base_url || defaultBase || null },
      {
        observer: async (r: HttpCallRecord) => {
          await ctx.db
            .query(
              `INSERT INTO provider_logs (connection_id, provider, method, endpoint, http_status, request_id,
                 provider_message_id, error, attempt, duration_ms, run_id, recipient_id, step_id, response_snippet)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
              [
                conn.id,
                r.provider,
                r.method,
                r.endpoint,
                r.httpStatus,
                r.requestId,
                r.providerMessageId,
                r.error,
                logCtx.attempt ?? null,
                r.durationMs,
                logCtx.runId ?? null,
                logCtx.recipientId ?? null,
                logCtx.stepId ?? null,
                r.responseSnippet,
              ],
            )
            .catch((e) => ctx.log.warn({ err: e }, 'provider_log insert failed'));
          ctx.log.info(
            {
              provider: r.provider,
              endpoint: r.endpoint,
              http_status: r.httpStatus,
              request_id: r.requestId,
              message_id: r.providerMessageId,
              run_id: logCtx.runId,
              recipient_id: logCtx.recipientId,
              duration_ms: r.durationMs,
              error: r.error,
            },
            'provider_call',
          );
        },
      },
    );
  };
}
