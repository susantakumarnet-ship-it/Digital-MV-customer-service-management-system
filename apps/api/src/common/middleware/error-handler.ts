import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../errors';
import { logger } from '../logger';

/** Central error handler: consistent body, no stack traces or internals leaked (API-02, App. B). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.requestId;

  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    return res.status(400).json({
      error: { code: 'VALIDATION_FAILED', message: 'Please correct the highlighted fields', fields, requestId },
    });
  }

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, requestId }, err.message);
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, fields: err.fields, details: err.details, requestId },
    });
  }

  // Malformed JSON body
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON', requestId } });
  }
  if ((err as { type?: string }).type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request is too large', requestId } });
  }

  // Duplicate key → 409 with the offending field
  const mongoErr = err as { code?: number; keyValue?: Record<string, unknown>; keyPattern?: Record<string, unknown> };
  if (mongoErr?.code === 11000) {
    const field = Object.keys(mongoErr.keyPattern ?? mongoErr.keyValue ?? {})[0] ?? 'value';
    return res.status(409).json({
      error: {
        code: 'DUPLICATE',
        message: `A record with this ${field} already exists`,
        fields: { [field]: 'Already in use' },
        requestId,
      },
    });
  }

  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid identifier', requestId } });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(err.errors)) fields[k] = v.message;
    return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Validation failed', fields, requestId } });
  }

  logger.error({ err, requestId, path: req.path }, 'Unhandled error');
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred. Please quote the request ID to support.', requestId },
  });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}`, requestId: req.requestId } });
}
