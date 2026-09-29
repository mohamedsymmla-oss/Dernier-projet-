import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import { one, type Db } from '../db/pool.js';

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

/**
 * Stockage dans PostgreSQL (table media_blobs), utilisé quand S3 n'est pas configuré.
 * Les fichiers sont servis par le backend lui-même via une URL signée (HMAC) à durée limitée :
 * GET /files/<clé>?exp=<epoch>&sig=<hmac>. Nécessite PUBLIC_BACKEND_URL pour que le fournisseur
 * puisse télécharger le fichier ; sans elle, seuls les usages internes (WhatsApp QR) fonctionnent.
 */
export class DatabaseStorage implements MediaStorage {
  readonly configured = true;
  private readonly signingKey: Buffer;
  constructor(
    private readonly db: Db,
    private readonly cfg: Pick<AppConfig, 'PUBLIC_BACKEND_URL' | 'MEDIA_URL_TTL_SECONDS' | 'JWT_SECRET'>,
    private readonly now: () => number = Date.now,
  ) {
    this.signingKey = crypto.createHmac('sha256', cfg.JWT_SECRET).update('media-url-signing-v1').digest();
  }
  get description() {
    return this.cfg.PUBLIC_BACKEND_URL
      ? 'Base de données PostgreSQL (fichiers servis par le serveur via URL signée)'
      : 'Base de données PostgreSQL (PUBLIC_BACKEND_URL manquante : URL publiques indisponibles pour le fournisseur)';
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.db.query(
      `INSERT INTO media_blobs (storage_key, content_type, data, size_bytes) VALUES ($1,$2,$3,$4)
       ON CONFLICT (storage_key) DO UPDATE SET content_type=EXCLUDED.content_type, data=EXCLUDED.data, size_bytes=EXCLUDED.size_bytes`,
      [key, contentType, body, body.length],
    );
  }
  sign(key: string, exp: number) {
    return crypto.createHmac('sha256', this.signingKey).update(`${key}\n${exp}`).digest('base64url');
  }
  verify(key: string, exp: number, sig: string) {
    if (!Number.isFinite(exp) || exp * 1000 < this.now()) return false;
    const expected = Buffer.from(this.sign(key, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }
  async publicUrl(key: string) {
    if (!this.cfg.PUBLIC_BACKEND_URL) throw new Error('PUBLIC_BACKEND_URL « À configurer » : URL publique du média indisponible');
    const exp = Math.floor(this.now() / 1000) + Math.min(this.cfg.MEDIA_URL_TTL_SECONDS, 7 * 24 * 3600);
    const base = this.cfg.PUBLIC_BACKEND_URL.replace(/\/+$/, '');
    const path = key.split('/').map(encodeURIComponent).join('/');
    return `${base}/files/${path}?exp=${exp}&sig=${this.sign(key, exp)}`;
  }
  async read(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    const row = await one(this.db, 'SELECT content_type, data FROM media_blobs WHERE storage_key=$1', [key]);
    return row ? { body: row.data as Buffer, contentType: row.content_type as string } : null;
  }
  async get(key: string) {
    const r = await this.read(key);
    if (!r) throw new Error('Fichier média absent du stockage');
    return r.body;
  }
  async delete(key: string) {
    await this.db.query('DELETE FROM media_blobs WHERE storage_key=$1', [key]);
  }
  async check() {
    try {
      await this.db.query('SELECT 1 FROM media_blobs LIMIT 1');
      return { ok: true, detail: this.description };
    } catch (e) {
      return { ok: false, detail: `Table media_blobs inaccessible : ${(e as Error).message}` };
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

/** S3/R2 si configuré, sinon PostgreSQL (persistant). */
export function createStorage(cfg: AppConfig, db: Db): MediaStorage {
  if (cfg.S3_BUCKET && cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY) return new S3Storage(cfg);
  return new DatabaseStorage(db, cfg);
}
