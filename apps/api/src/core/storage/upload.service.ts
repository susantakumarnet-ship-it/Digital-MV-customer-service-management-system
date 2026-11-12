import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import type { ClientSession, Types } from 'mongoose';
import { fileTypeFromBuffer } from 'file-type';
import { env } from '../../config/env';
import type { RequestContext } from '../../common/context';
import { AppError, badRequest } from '../../common/errors';
import { logger } from '../../common/logger';
import { audit } from '../audit/audit.service';
import { getSettingsGroup } from '../settings/settings.service';
import { Attachment } from './attachment.model';
import { storage } from './storage.service';

export interface IncomingFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** Accepted content types per extension; content is verified by magic bytes, never by name alone. */
const EXT_MIME: Record<string, string[]> = {
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  heic: ['image/heic', 'image/heif'],
  heif: ['image/heif', 'image/heic'],
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  mp4: ['video/mp4'],
  zip: ['application/zip'],
};
/** Plain-text formats have no magic bytes; accepted only if the content is valid UTF-8 text. */
const TEXT_EXT: Record<string, string> = { txt: 'text/plain', csv: 'text/csv' };

export function sanitizeFilename(name: string) {
  const base = path.basename(name.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').replace(/^\.+/, '').trim();
  return (clean || 'file').slice(0, 150);
}

function isProbablyText(buf: Buffer) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, 64 * 1024));
    return true;
  } catch {
    return false;
  }
}

/** Optional ClamAV INSTREAM scan (D-23). Returns null when scanning is not configured. */
async function clamScan(buf: Buffer): Promise<'CLEAN' | 'INFECTED' | null> {
  const host = env().CLAMAV_HOST;
  if (!host) return null;
  return new Promise((resolve, reject) => {
    const sock = net.connect(env().CLAMAV_PORT, host);
    let reply = '';
    sock.setTimeout(20_000, () => sock.destroy(new Error('ClamAV timeout')));
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < buf.length; i += 64 * 1024) {
        const chunk = buf.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(len);
        sock.write(chunk);
      }
      sock.write(Buffer.alloc(4));
    });
    sock.on('data', (d) => (reply += d.toString()));
    sock.on('end', () => resolve(/FOUND/.test(reply) ? 'INFECTED' : 'CLEAN'));
    sock.on('error', reject);
  });
}

export interface ValidatedFile {
  originalName: string;
  extension: string;
  mimeType: string;
  size: number;
  sha256: string;
  buffer: Buffer;
}

/**
 * Validates a batch against the configured policy (CFG-04, D-20): allowed extensions, per-file size,
 * file count and total size per record (including files already attached), and real content type.
 */
export async function validateFiles(files: IncomingFile[], existing: { count: number; bytes: number } = { count: 0, bytes: 0 }) {
  const policy = await getSettingsGroup('attachments');
  const maxFile = policy.maxFileSizeMb * 1024 * 1024;
  if (existing.count + files.length > policy.maxFilesPerRecord) {
    throw badRequest(`At most ${policy.maxFilesPerRecord} files can be attached to one record.`);
  }
  const total = existing.bytes + files.reduce((a, f) => a + f.size, 0);
  if (total > policy.maxTotalSizeMbPerRecord * 1024 * 1024) {
    throw badRequest(`Attachments for one record may not exceed ${policy.maxTotalSizeMbPerRecord} MB in total.`);
  }
  const out: ValidatedFile[] = [];
  for (const f of files) {
    const name = sanitizeFilename(f.originalname);
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!ext || !policy.allowedExtensions.includes(ext)) {
      throw badRequest(`"${name}": file type not allowed. Allowed: ${policy.allowedExtensions.join(', ')}.`);
    }
    if (f.size === 0) throw badRequest(`"${name}" is empty.`);
    if (f.size > maxFile) throw badRequest(`"${name}" is larger than ${policy.maxFileSizeMb} MB.`);

    let mimeType: string;
    if (TEXT_EXT[ext]) {
      if (!isProbablyText(f.buffer)) throw badRequest(`"${name}" does not contain valid text.`);
      mimeType = TEXT_EXT[ext];
    } else {
      const detected = await fileTypeFromBuffer(f.buffer);
      const allowed = EXT_MIME[ext];
      if (!detected || !allowed || !allowed.includes(detected.mime)) {
        throw badRequest(`"${name}": the file content does not match its .${ext} extension.`);
      }
      mimeType = detected.mime;
    }
    out.push({
      originalName: name,
      extension: ext,
      mimeType,
      size: f.size,
      sha256: createHash('sha256').update(f.buffer).digest('hex'),
      buffer: f.buffer,
    });
  }
  return out;
}

/**
 * Scans and stores validated files, then creates attachment records in the caller's transaction.
 * Files are written to storage before the DB commit; if the transaction aborts, orphan objects are
 * harmless (unreferenced) and can be swept by a maintenance job.
 */
export async function storeFiles(
  ctx: RequestContext,
  files: ValidatedFile[],
  owner: { type: string; id: Types.ObjectId | string; context?: string },
  uploader: { type: 'USER' | 'PUBLIC'; name?: string },
  session?: ClientSession,
) {
  const created = [];
  for (const f of files) {
    let scanStatus: 'NOT_SCANNED' | 'CLEAN' | 'INFECTED' = 'NOT_SCANNED';
    try {
      scanStatus = (await clamScan(f.buffer)) ?? 'NOT_SCANNED';
    } catch (err) {
      logger.error({ err }, 'Malware scan failed');
      throw new AppError(503, 'SCAN_UNAVAILABLE', 'File scanning is temporarily unavailable. Please try again later.');
    }
    if (scanStatus === 'INFECTED') {
      await audit(ctx, {
        action: 'attachment.rejected.malware',
        entityType: owner.type,
        entityId: owner.id,
        outcome: 'FAILURE',
        meta: { filename: f.originalName, sha256: f.sha256 },
      });
      throw badRequest(`"${f.originalName}" was rejected by the malware scanner.`);
    }
    const now = new Date();
    const key = `${owner.type}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${f.extension}`;
    await storage().put(key, f.buffer, f.mimeType);
    const [doc] = await Attachment.create(
      [
        {
          ownerType: owner.type,
          ownerId: owner.id,
          context: owner.context ?? 'general',
          originalName: f.originalName,
          extension: f.extension,
          mimeType: f.mimeType,
          size: f.size,
          sha256: f.sha256,
          storageKey: key,
          scanStatus,
          uploaderType: uploader.type,
          uploadedBy: uploader.type === 'USER' ? ctx.auth?.userId : undefined,
          uploadedByName: uploader.name ?? ctx.auth?.name,
          uploadedIp: ctx.ip,
        },
      ],
      { session },
    );
    created.push(doc);
  }
  return created;
}

export async function attachmentUsage(ownerType: string, ownerId: Types.ObjectId | string) {
  const rows = await Attachment.find({ ownerType, ownerId, removedAt: null }).select('size').lean();
  return { count: rows.length, bytes: rows.reduce((a, r) => a + r.size, 0) };
}
