import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppConfig } from '../config.js';

/**
 * Stockage durable des médias (S3, Cloudflare R2, MinIO…).
 * Jamais le disque local de Railway, qui est effacé à chaque déploiement.
 */
export interface MediaStorage {
  readonly configured: boolean;
  readonly description: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** URL accessible par le fournisseur WhatsApp (publique ou pré-signée). */
  publicUrl(key: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  check(): Promise<{ ok: boolean; detail: string }>;
}

export class S3Storage implements MediaStorage {
  readonly configured = true;
  private client: S3Client;
  constructor(private readonly cfg: AppConfig) {
    this.client = new S3Client({
      region: cfg.S3_REGION,
      endpoint: cfg.S3_ENDPOINT || undefined,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID!, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY! },
    });
  }
  get description() {
    return `S3 compatible (bucket ${this.cfg.S3_BUCKET})`;
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  }
  async publicUrl(key: string) {
    if (this.cfg.S3_PUBLIC_BASE_URL) return `${this.cfg.S3_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${key}`;
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key }), {
      expiresIn: Math.min(this.cfg.MEDIA_URL_TTL_SECONDS, 7 * 24 * 3600),
    });
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key }));
  }
  async check() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.S3_BUCKET }));
      return { ok: true, detail: this.description };
    } catch (e) {
      return { ok: false, detail: `Bucket inaccessible : ${(e as Error).message}` };
    }
  }
}

/** Utilisé quand S3 n'est pas configuré : l'import de fichiers est désactivé (« À configurer »), les URL publiques restent possibles. */
export class UnconfiguredStorage implements MediaStorage {
  readonly configured = false;
  readonly description = 'Stockage non configuré (S3_* manquants) : seules les URL publiques sont disponibles';
  private fail(): never {
    throw new Error(this.description);
  }
  async put() {
    this.fail();
  }
  async publicUrl(): Promise<string> {
    this.fail();
  }
  async get(): Promise<Buffer> {
    this.fail();
  }
  async delete() {
    this.fail();
  }
  async check() {
    return { ok: false, detail: this.description };
  }
}

/** Stockage mémoire pour les tests automatisés uniquement. */
export class MemoryStorage implements MediaStorage {
  readonly configured = true;
  readonly description = 'Mémoire (tests)';
  objects = new Map<string, { body: Buffer; contentType: string }>();
  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async publicUrl(key: string) {
    return `https://storage.test/${key}?sig=abc`;
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) throw new Error('not found');
    return o.body;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async check() {
    return { ok: true, detail: this.description };
  }
}

export function createStorage(cfg: AppConfig): MediaStorage {
  if (cfg.S3_BUCKET && cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY) return new S3Storage(cfg);
  return new UnconfiguredStorage();
}
