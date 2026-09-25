import crypto from 'node:crypto';

/** Chiffrement AES-256-GCM des secrets stockés en base (clés API, secrets webhook). */
export class SecretBox {
  private readonly key: Buffer;

  constructor(rawKey: string) {
    let key: Buffer;
    if (/^[0-9a-f]{64}$/i.test(rawKey)) key = Buffer.from(rawKey, 'hex');
    else key = Buffer.from(rawKey, 'base64');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY doit faire 32 octets (64 caractères hex ou base64). Générer : openssl rand -hex 32');
    }
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const [v, iv, tag, data] = payload.split(':');
    if (v !== 'v1' || !iv || !tag || !data) throw new Error('Format de secret chiffré invalide');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

/** sk_live_abcdef123456789 → sk_live_***********789 */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  const prefixMatch = secret.match(/^([a-z]+_(?:live|test)_)/i);
  const prefix = prefixMatch ? prefixMatch[1]! : secret.slice(0, Math.min(3, Math.floor(secret.length / 4)));
  const suffix = secret.length > 8 ? secret.slice(-3) : '';
  const hidden = Math.max(4, secret.length - prefix.length - suffix.length);
  return prefix + '*'.repeat(Math.min(hidden, 11)) + suffix;
}

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
