import { z } from 'zod';
import { env } from '../../config/env';
import type { AuthContext } from '../../common/context';
import { forbidden, notFound } from '../../common/errors';
import { ApiRouter, idParams } from '../../common/http/route';
import { audit } from '../../core/audit/audit.service';
import { Attachment } from '../../core/storage/attachment.model';
import { storage, verifyLocalSignature } from '../../core/storage/storage.service';

/**
 * Each owning module registers how to decide whether a user may read its attachments
 * (record-level authorisation, SEC-05). Unknown owner types are denied (fail closed).
 */
type OwnerAccess = (auth: AuthContext, ownerId: string, attachment: { context?: string | null }) => Promise<boolean>;
const ownerAccess = new Map<string, OwnerAccess>();
export function registerAttachmentOwner(ownerType: string, check: OwnerAccess) {
  ownerAccess.set(ownerType, check);
}

export const filesRouter = new ApiRouter('/files', 'Files');

filesRouter
  .route({
    method: 'get',
    path: '/:id/url',
    summary: 'Issue a short-lived signed download URL after checking access to the owning record',
    access: {},
    params: idParams,
    query: z.object({ inline: z.enum(['true', 'false']).default('false') }),
    handler: async ({ auth, params, query, ctx }) => {
      const a = await Attachment.findById(params.id).select('+storageKey').lean();
      if (!a || a.removedAt) throw notFound('File');
      const check = ownerAccess.get(a.ownerType);
      if (!check || !(await check(auth, String(a.ownerId), a))) throw notFound('File');
      if (a.scanStatus === 'INFECTED' || a.scanStatus === 'PENDING') throw forbidden('This file is not available for download.');
      const url = await storage().signedUrl(a.storageKey, {
        fileId: String(a._id),
        filename: a.originalName,
        contentType: a.mimeType,
        inline: query.inline === 'true',
      });
      await audit(ctx, { action: 'attachment.download', entityType: a.ownerType, entityId: a.ownerId, meta: { attachmentId: String(a._id), filename: a.originalName } });
      return { url, expiresInSeconds: env().SIGNED_URL_TTL_SECONDS };
    },
  })
  .route({
    method: 'get',
    path: '/:id/content',
    summary: 'Download file content using a signed URL (local storage driver)',
    description: 'The HMAC signature in the query string is the authorisation; it expires after SIGNED_URL_TTL_SECONDS.',
    access: { public: true },
    params: idParams,
    query: z.object({ exp: z.coerce.number().int(), inline: z.enum(['0', '1']).default('0'), sig: z.string().min(20).max(100) }),
    raw: true,
    handler: async ({ params, query, res }) => {
      const inline = query.inline === '1';
      if (!verifyLocalSignature(params.id, query.exp, inline, query.sig)) throw forbidden('This download link is invalid or has expired.', 'LINK_EXPIRED');
      const a = await Attachment.findById(params.id).select('+storageKey').lean();
      if (!a || a.removedAt) throw notFound('File');
      const { stream, size } = await storage().read(a.storageKey);
      // Only images and PDFs may render inline; everything else is forced to download.
      const canInline = inline && (/^image\/(jpeg|png|gif|webp)$/.test(a.mimeType) || a.mimeType === 'application/pdf');
      res.setHeader('Content-Type', a.mimeType);
      res.setHeader('Content-Length', String(size));
      res.setHeader('Content-Disposition', `${canInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.originalName)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('Cache-Control', 'private, no-store');
      stream.pipe(res);
    },
  });
