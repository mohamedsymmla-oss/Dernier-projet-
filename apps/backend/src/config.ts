import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** api = HTTP seulement, worker = files seulement, all = les deux (défaut Railway simple) */
  APP_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL est obligatoire'),
  DATABASE_SSL: bool,
  REDIS_URL: z.string().min(1, 'REDIS_URL est obligatoire'),

  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY est obligatoire (32 octets en base64 ou hex)'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET doit contenir au moins 32 caractères'),
  SESSION_DAYS: z.coerce.number().default(30),
  PUBLIC_BACKEND_URL: z.string().url().optional(),
  CORS_ORIGINS: z.string().optional(),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(10).optional(),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  MEDIA_URL_TTL_SECONDS: z.coerce.number().default(6 * 3600),

  SENDZEN_API_BASE_URL: z.string().url().optional(),
  SENDZEN_SANDBOX_API_BASE_URL: z.string().url().optional(),
  SENDZEN_PARTNER_API_KEY: z.string().optional(),

  A1_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  PROVIDER_MAX_MESSAGES_PER_SECOND: z.coerce.number().min(0.1).default(10),
  STEP_GAP_MS: z.coerce.number().int().min(0).default(1500),
  SEND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  RETRY_BASE_MS: z.coerce.number().int().min(10).default(2000),
  RETRY_MAX_MS: z.coerce.number().int().min(100).default(5 * 60_000),
  ALLOW_PRIVATE_MEDIA_URLS: bool,
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration invalide :\n${msg}`);
  }
  return parsed.data;
}
