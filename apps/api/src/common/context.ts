import type { Request } from 'express';
import type { Types } from 'mongoose';
import type { PermissionKey, UserScope } from '@mv/shared';

/** Authenticated principal attached to req.auth by the authenticate middleware. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  name: string;
  email: string;
  organizationId?: string;
  roles: { id: string; key?: string; name: string }[];
  permissions: Set<PermissionKey>;
  scope: UserScope;
  /** Restricted sessions may only reach the endpoints needed to complete MFA setup / password change. */
  restriction?: 'MFA_SETUP_REQUIRED' | 'PASSWORD_CHANGE_REQUIRED';
}

/** Who/where an action came from — passed to services for audit and authorisation. */
export interface RequestContext {
  auth?: AuthContext;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
    requestId?: string;
  }
}

export function ctxFrom(req: Request): RequestContext {
  return {
    auth: req.auth,
    ip: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 400),
    requestId: req.requestId,
  };
}

export const systemContext: RequestContext = { requestId: 'system' };

export type Id = string | Types.ObjectId;
