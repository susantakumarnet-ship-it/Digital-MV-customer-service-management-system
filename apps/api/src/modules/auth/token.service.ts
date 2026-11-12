import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

const ISSUER = 'mv-csms';
const AUDIENCE = 'mv-web';

export interface AccessClaims {
  sub: string;
  sid: string;
  typ: 'access';
}
export interface MfaChallengeClaims {
  sub: string;
  typ: 'mfa';
  ip?: string;
}

export function signAccessToken(userId: string, sessionId: string) {
  const ttl = env().JWT_ACCESS_TTL_SECONDS;
  const token = jwt.sign({ sid: sessionId, typ: 'access' }, env().JWT_ACCESS_SECRET, {
    subject: userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: ttl,
    algorithm: 'HS256',
  });
  return { token, expiresIn: ttl };
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const c = jwt.verify(token, env().JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    if (c.typ !== 'access' || !c.sub || !c.sid) return null;
    return { sub: c.sub, sid: c.sid as string, typ: 'access' };
  } catch {
    return null;
  }
}

/** Short-lived token proving the password step succeeded, exchanged for a session after TOTP. */
export function signMfaChallenge(userId: string) {
  return jwt.sign({ typ: 'mfa' }, env().JWT_ACCESS_SECRET, {
    subject: userId,
    issuer: ISSUER,
    audience: `${AUDIENCE}-mfa`,
    expiresIn: 300,
    algorithm: 'HS256',
  });
}

export function verifyMfaChallenge(token: string): MfaChallengeClaims | null {
  try {
    const c = jwt.verify(token, env().JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: `${AUDIENCE}-mfa`,
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    if (c.typ !== 'mfa' || !c.sub) return null;
    return { sub: c.sub, typ: 'mfa' };
  } catch {
    return null;
  }
}
