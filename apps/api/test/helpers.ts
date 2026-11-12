import request from 'supertest';
import type { Express } from 'express';
import type { PermissionKey, UserScope } from '@mv/shared';
import { createApp } from '../src/app';
import { hashPassword } from '../src/common/crypto';
import { seedBase } from '../src/db/seeds/base';
import { Role } from '../src/modules/roles/role.model';
import { User } from '../src/modules/users/user.model';

export const PASSWORD = 'Test-Passw0rd-123';
export const ADMIN_EMAIL = 'admin@test.local';

let app: Express | undefined;
export function getApp() {
  app ??= createApp();
  return app;
}

let seeded = false;
export async function bootstrap() {
  if (!seeded) {
    await seedBase(() => undefined, ADMIN_EMAIL, PASSWORD);
    // Tests start with an admin who does not need to change password.
    await User.updateOne({ email: ADMIN_EMAIL }, { $set: { mustChangePassword: false } });
    seeded = true;
  }
  return getApp();
}

export async function createUser(opts: {
  email: string;
  roleKeys?: string[];
  roleIds?: string[];
  scope?: Partial<UserScope>;
  organizationId?: string;
  mustChangePassword?: boolean;
  status?: string;
}) {
  const roles = opts.roleKeys ? await Role.find({ key: { $in: opts.roleKeys } }).lean() : [];
  const u = await User.create({
    name: opts.email.split('@')[0],
    email: opts.email,
    passwordHash: await hashPassword(PASSWORD),
    roleIds: [...roles.map((r) => r._id), ...(opts.roleIds ?? [])],
    organizationId: opts.organizationId,
    scope: { global: false, organizationIds: [], regionIds: [], siteIds: [], ...opts.scope },
    status: opts.status ?? 'ACTIVE',
    mustChangePassword: opts.mustChangePassword ?? false,
  });
  return u;
}

export async function createRole(name: string, permissions: PermissionKey[]) {
  return Role.create({ name, permissions, isSystem: false });
}

export interface Session {
  token: string;
  csrf: string;
  refreshCookie: string;
  cookies: string[];
  body: any;
}

export function parseCookies(res: request.Response) {
  const raw = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const get = (name: string) => raw.find((c) => c.startsWith(`${name}=`))?.split(';')[0].split('=')[1] ?? '';
  return { raw, refresh: get('mv_rt'), csrf: get('mv_csrf') };
}

export async function login(email: string, password = PASSWORD): Promise<Session> {
  const res = await request(getApp()).post('/api/v1/auth/login').send({ identifier: email, password });
  if (res.status !== 200 || !res.body.accessToken) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const c = parseCookies(res);
  return { token: res.body.accessToken, csrf: c.csrf, refreshCookie: c.refresh, cookies: c.raw, body: res.body };
}

export function api(token?: string) {
  const app = getApp();
  const wrap = (r: request.Test) => (token ? r.set('Authorization', `Bearer ${token}`) : r);
  return {
    get: (url: string) => wrap(request(app).get(`/api/v1${url}`)),
    post: (url: string) => wrap(request(app).post(`/api/v1${url}`)),
    put: (url: string) => wrap(request(app).put(`/api/v1${url}`)),
    patch: (url: string) => wrap(request(app).patch(`/api/v1${url}`)),
    delete: (url: string) => wrap(request(app).delete(`/api/v1${url}`)),
  };
}

export function refresh(session: Pick<Session, 'refreshCookie' | 'csrf'>) {
  return request(getApp())
    .post('/api/v1/auth/refresh')
    .set('Cookie', [`mv_rt=${session.refreshCookie}`, `mv_csrf=${session.csrf}`])
    .set('X-CSRF-Token', session.csrf);
}
