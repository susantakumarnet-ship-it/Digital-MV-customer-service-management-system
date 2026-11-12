import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { tooMany } from '../errors';

export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/**
 * Strips MongoDB operator keys ($…) and dotted keys from JSON bodies (defence in depth against
 * NoSQL injection; all inputs are additionally validated with Zod).
 */
export function sanitizeBody(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') req.body = clean(req.body, 0);
  next();
}

function clean(value: unknown, depth: number): unknown {
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = clean(v, depth + 1);
  }
  return out;
}

/** Rate limiter that produces the standard error body (SEC-03). In-memory store: one instance. */
export function limiter(opts: Partial<Options> & { windowMs: number; limit: Options['limit'] }) {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_IN_TESTS !== 'true',
    handler: (_req, _res, next) => next(tooMany()),
    ...opts,
  });
}
