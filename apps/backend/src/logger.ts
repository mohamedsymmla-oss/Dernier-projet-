import pino from 'pino';

/** Logs structurés JSON. Les champs sensibles sont masqués automatiquement. */
export function createLogger(level: string) {
  return pino({
    level,
    base: { service: 'wa-automation' },
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        '*.apiKey',
        '*.api_key',
        '*.password',
        '*.webhookSecret',
        '*.token',
        'apiKey',
        'password',
        'webhookSecret',
      ],
      censor: '[masqué]',
    },
  });
}
export type Logger = pino.Logger;
