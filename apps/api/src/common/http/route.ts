import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import type { PermissionKey } from '@mv/shared';
import { objectId } from '@mv/shared';
import { authenticate, enforceRestriction, requirePermissions } from '../middleware/auth';
import { ctxFrom, type AuthContext, type RequestContext } from '../context';
import { registry } from './openapi';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type Access =
  | { public: true }
  | {
      /** All required (default deny). Empty list = any authenticated user. */
      permissions?: PermissionKey[];
      /** At least one required. */
      anyOf?: PermissionKey[];
      /** Reachable while the session is restricted (MFA setup / forced password change). */
      allowRestricted?: boolean;
    };

type Infer<S> = S extends ZodTypeAny ? z.infer<S> : undefined;

export interface RouteSpec<B, Q, P> {
  method: Method;
  path: string;
  summary: string;
  description?: string;
  access: Access;
  body?: B;
  query?: Q;
  params?: P;
  /** HTTP status for success (default 200, or 201 for POST creating resources when set). */
  status?: number;
  /** Extra middleware (rate limiters, multipart parsers) run after auth, before validation. */
  middleware?: RequestHandler[];
  /** OpenAPI: describe a non-JSON request (e.g. multipart upload). */
  multipart?: boolean;
  /** Response is streamed by the handler (files); handler must write the response itself. */
  raw?: boolean;
  handler: (args: {
    req: Request;
    res: Response;
    body: Infer<B>;
    query: Infer<Q>;
    params: Infer<P>;
    ctx: RequestContext;
    /** Always set on protected routes (authenticate runs first). Undefined on public routes — don't use it there. */
    auth: AuthContext;
  }) => unknown | Promise<unknown>;
}

export const idParams = z.object({ id: objectId });

export class ApiRouter {
  readonly router = Router();

  constructor(
    /** Mount path below /api/v1, e.g. "/users". */
    readonly base: string,
    readonly tag: string,
  ) {}

  route<B extends ZodTypeAny | undefined = undefined, Q extends ZodTypeAny | undefined = undefined, P extends ZodTypeAny | undefined = undefined>(
    spec: RouteSpec<B, Q, P>,
  ) {
    const access = spec.access as Access;
    const isPublic = 'public' in access && access.public;
    const chain: RequestHandler[] = [];
    if (!isPublic) {
      const a = access as Exclude<Access, { public: true }>;
      chain.push(authenticate, enforceRestriction(Boolean(a.allowRestricted)), requirePermissions(a.permissions, a.anyOf));
    }
    chain.push(...(spec.middleware ?? []));

    const handler: RequestHandler = async (req, res) => {
      // Zod parse errors propagate to the central error handler (400 VALIDATION_FAILED).
      const body = spec.body ? (spec.body as ZodTypeAny).parse(req.body ?? {}) : undefined;
      const query = spec.query ? (spec.query as ZodTypeAny).parse(req.query ?? {}) : undefined;
      const params = spec.params ? (spec.params as ZodTypeAny).parse(req.params ?? {}) : undefined;
      const result = await spec.handler({
        req,
        res,
        body,
        query,
        params,
        ctx: ctxFrom(req),
        auth: req.auth as never,
      } as never);
      if (spec.raw || res.headersSent) return;
      if (result === undefined || result === null) {
        res.status(spec.status === 201 ? 201 : 204).end();
        return;
      }
      res.status(spec.status ?? 200).json(result);
    };

    this.router[spec.method](spec.path, ...chain, handler);
    this.document(spec, access, isPublic);
    return this;
  }

  private document(spec: RouteSpec<unknown, unknown, unknown>, access: Access, isPublic: boolean) {
    const fullPath = `/api/v1${this.base}${spec.path}`.replace(/\/$/, '').replace(/:(\w+)/g, '{$1}');
    const a = access as Exclude<Access, { public: true }>;
    const permText = isPublic
      ? 'Public endpoint (no authentication).'
      : [
          a.permissions?.length ? `Requires: \`${a.permissions.join('`, `')}\`.` : 'Any authenticated user.',
          a.anyOf?.length ? `Requires one of: \`${a.anyOf.join('`, `')}\`.` : '',
        ]
          .filter(Boolean)
          .join(' ');
    try {
      registry.registerPath({
        method: spec.method,
        path: fullPath,
        tags: [this.tag],
        summary: spec.summary,
        description: [spec.description, permText].filter(Boolean).join('\n\n'),
        security: isPublic ? [] : [{ bearerAuth: [] }],
        request: {
          ...(spec.params ? { params: spec.params as never } : {}),
          ...(spec.query ? { query: spec.query as never } : {}),
          ...(spec.body
            ? { body: { content: { 'application/json': { schema: spec.body as never } } } }
            : spec.multipart
              ? {
                  body: {
                    content: {
                      'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } },
                    },
                  },
                }
              : {}),
        },
        responses: {
          [String(spec.status ?? 200)]: { description: 'Success' },
          ...(spec.body || spec.query ? { 400: { description: 'Validation failed' } } : {}),
          ...(isPublic ? {} : { 401: { description: 'Not authenticated' }, 403: { description: 'Forbidden' } }),
        },
      });
    } catch {
      // Documentation generation must never prevent the API from starting.
    }
  }
}

/** Standard paginated envelope. */
export function paged<T>(data: T[], total: number, page: number, limit: number) {
  return { data, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
}

/** Parses "field" / "-field" sort strings against an allow-list (API-03). */
export function parseSort(sort: string | undefined, allowed: string[], fallback: Record<string, 1 | -1>) {
  if (!sort) return fallback;
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  if (!allowed.includes(field)) return fallback;
  return { [field]: desc ? -1 : 1, _id: 1 } as Record<string, 1 | -1>;
}
