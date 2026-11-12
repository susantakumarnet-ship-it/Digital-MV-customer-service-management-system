import { createHmac, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env';
import { safeEqual } from '../../common/crypto';

/**
 * Private object storage (SEC-05, HO §7.1). Files are never served from a public path: downloads go
 * through short-lived signed URLs issued only after a permission check (GET /files/:id/url).
 * Storage keys are opaque and never exposed to clients.
 */
export interface StorageProvider {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Time-limited URL for downloading (inline=false → attachment). */
  signedUrl(key: string, opts: { fileId: string; filename: string; contentType: string; inline?: boolean }): Promise<string>;
  read(key: string): Promise<{ stream: Readable; size: number }>;
  remove(key: string): Promise<void>;
}

function fileUrlSecret() {
  return env().FILE_URL_SECRET ?? createHash('sha256').update(`file-url:${env().JWT_ACCESS_SECRET}`).digest('hex');
}

/** HMAC signature for local-driver download links: binds file id, expiry and disposition. */
export function signLocal(fileId: string, exp: number, inline: boolean) {
  return createHmac('sha256', fileUrlSecret()).update(`${fileId}.${exp}.${inline ? 1 : 0}`).digest('base64url');
}

export function verifyLocalSignature(fileId: string, exp: number, inline: boolean, sig: string) {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return safeEqual(signLocal(fileId, exp, inline), sig);
}

class LocalStorage implements StorageProvider {
  private root = path.resolve(process.cwd(), env().STORAGE_LOCAL_DIR);

  private resolve(key: string) {
    // Keys are generated server-side, but guard against traversal anyway.
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return full;
  }
  async put(key: string, body: Buffer) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, { flag: 'wx' });
  }
  async signedUrl(_key: string, opts: { fileId: string; inline?: boolean }) {
    const exp = Math.floor(Date.now() / 1000) + env().SIGNED_URL_TTL_SECONDS;
    const inline = Boolean(opts.inline);
    return `/api/v1/files/${opts.fileId}/content?exp=${exp}&inline=${inline ? 1 : 0}&sig=${signLocal(opts.fileId, exp, inline)}`;
  }
  async read(key: string) {
    const full = this.resolve(key);
    const s = await stat(full);
    return { stream: createReadStream(full), size: s.size };
  }
  async remove(key: string) {
    await unlink(this.resolve(key)).catch(() => undefined);
  }
}

class S3Storage implements StorageProvider {
  private client: S3Client;
  private bucket: string;
  constructor() {
    const e = env();
    this.bucket = e.S3_BUCKET!;
    this.client = new S3Client({
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      credentials: e.S3_ACCESS_KEY_ID ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY ?? '' } : undefined,
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }),
    );
  }
  async signedUrl(key: string, opts: { filename: string; contentType: string; inline?: boolean }) {
    const disposition = `${opts.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(opts.filename)}`;
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: disposition, ResponseContentType: opts.contentType }),
      { expiresIn: env().SIGNED_URL_TTL_SECONDS },
    );
  }
  async read(key: string) {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return { stream: out.Body as Readable, size: Number(out.ContentLength ?? 0) };
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let provider: StorageProvider | undefined;
export function storage(): StorageProvider {
  provider ??= env().STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();
  return provider;
}
