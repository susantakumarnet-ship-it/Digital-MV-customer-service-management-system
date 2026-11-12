import { authenticator } from 'otplib';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit/audit.model';
import { capturedMail } from '../src/core/mail/mail.service';
import { updateSettingsGroup } from '../src/core/settings/settings.service';
import { Session } from '../src/modules/auth/session.model';
import { User } from '../src/modules/users/user.model';
import { ADMIN_EMAIL, PASSWORD, api, bootstrap, createUser, getApp, login, parseCookies, refresh } from './helpers';

beforeAll(async () => {
  await bootstrap();
});

describe('AUTH-01 login', () => {
  it('signs in with email or username and returns user + permissions', async () => {
    const s = await login(ADMIN_EMAIL);
    expect(s.body.user.email).toBe(ADMIN_EMAIL);
    expect(s.body.user.permissions).toContain('user.administer');
    expect(s.refreshCookie).toBeTruthy();
    expect(s.cookies.find((c) => c.startsWith('mv_rt='))).toMatch(/HttpOnly/i);
    expect(s.cookies.find((c) => c.startsWith('mv_rt='))).toMatch(/SameSite=Strict/i);
    const byUsername = await request(getApp()).post('/api/v1/auth/login').send({ identifier: 'admin', password: PASSWORD });
    expect(byUsername.status).toBe(200);
  });

  it('rejects bad credentials with a generic message and audits the failure', async () => {
    const unknown = await request(getApp()).post('/api/v1/auth/login').send({ identifier: 'nobody@test.local', password: 'x' });
    const wrong = await request(getApp()).post('/api/v1/auth/login').send({ identifier: ADMIN_EMAIL, password: 'wrong-password' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message); // no account enumeration
    expect(await AuditLog.countDocuments({ action: 'auth.login.failure', outcome: 'FAILURE' })).toBeGreaterThanOrEqual(2);
  });

  it('locks the account after the configured number of failures', async () => {
    await createUser({ email: 'lock@test.local', roleKeys: ['ENGINEER'] });
    for (let i = 0; i < 4; i++) {
      const r = await request(getApp()).post('/api/v1/auth/login').send({ identifier: 'lock@test.local', password: 'bad' });
      expect(r.status).toBe(401);
    }
    const fifth = await request(getApp()).post('/api/v1/auth/login').send({ identifier: 'lock@test.local', password: 'bad' });
    expect(fifth.status).toBe(423);
    // Even the correct password is refused while locked.
    const correct = await request(getApp()).post('/api/v1/auth/login').send({ identifier: 'lock@test.local', password: PASSWORD });
    expect(correct.status).toBe(423);
    expect(correct.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('refuses inactive accounts', async () => {
    await createUser({ email: 'inactive@test.local', roleKeys: ['ENGINEER'], status: 'INACTIVE' });
    const r = await request(getApp()).post('/api/v1/auth/login').send({ identifier: 'inactive@test.local', password: PASSWORD });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ACCOUNT_INACTIVE');
  });
});

describe('AUTH-04 sessions and refresh rotation', () => {
  it('requires CSRF header on refresh', async () => {
    const s = await login(ADMIN_EMAIL);
    const r = await request(getApp()).post('/api/v1/auth/refresh').set('Cookie', [`mv_rt=${s.refreshCookie}`, `mv_csrf=${s.csrf}`]);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CSRF_FAILED');
  });

  it('rotates the refresh token, and detects reuse of an old token', async () => {
    const s = await login(ADMIN_EMAIL);
    const r1 = await refresh(s);
    expect(r1.status).toBe(200);
    const next = parseCookies(r1);
    expect(next.refresh).not.toBe(s.refreshCookie);

    // Immediate replay = benign multi-tab race → 409, session stays valid.
    const race = await refresh(s);
    expect(race.status).toBe(409);
    expect(race.body.error.code).toBe('REFRESH_RACE');

    // Age the rotation beyond the grace window → replay is treated as theft and the session is revoked.
    await Session.updateMany({ 'rotatedHashes.0': { $exists: true } }, { $set: { 'rotatedHashes.$[].at': new Date(Date.now() - 60_000) } });
    const replay = await refresh(s);
    expect(replay.status).toBe(401);
    const afterTheft = await refresh({ refreshCookie: next.refresh, csrf: next.csrf });
    expect(afterTheft.status).toBe(401);
    expect(await AuditLog.countDocuments({ action: 'auth.refresh.reuseDetected' })).toBeGreaterThanOrEqual(1);
  });

  it('logout revokes the session; access token stops working immediately', async () => {
    const s = await login(ADMIN_EMAIL);
    expect((await api(s.token).get('/auth/me')).status).toBe(200);
    const out = await request(getApp())
      .post('/api/v1/auth/logout')
      .set('Cookie', [`mv_rt=${s.refreshCookie}`, `mv_csrf=${s.csrf}`])
      .set('X-CSRF-Token', s.csrf);
    expect(out.status).toBe(204);
    const me = await api(s.token).get('/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_INVALID');
  });

  it('enforces the idle timeout', async () => {
    const s = await login(ADMIN_EMAIL);
    const sid = JSON.parse(Buffer.from(s.token.split('.')[1], 'base64url').toString()).sid;
    // Default idle timeout is 60 minutes; simulate 2 hours of inactivity on this session.
    await Session.updateOne({ _id: sid }, { $set: { lastSeenAt: new Date(Date.now() - 2 * 3600_000) } });
    const me = await api(s.token).get('/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_IDLE_TIMEOUT');
    expect((await Session.findById(sid).lean())!.revokedReason).toBe('IDLE_TIMEOUT');
  });

  it('lists and revokes own sessions', async () => {
    const a = await login(ADMIN_EMAIL);
    const b = await login(ADMIN_EMAIL);
    const list = await api(a.token).get('/auth/sessions');
    expect(list.status).toBe(200);
    const other = list.body.find((x: any) => !x.current);
    expect(other).toBeTruthy();
    expect((await api(a.token).delete(`/auth/sessions/${other.id}`)).status).toBe(204);
    // b may or may not be `other`, but at least one session is now revoked
    const after = await api(a.token).get('/auth/sessions');
    expect(after.body.length).toBe(list.body.length - 1);
    void b;
  });
});

describe('AUTH-03 deactivation takes effect immediately', () => {
  it('rejects the access token of a user deactivated mid-session', async () => {
    await createUser({ email: 'deact@test.local', roleKeys: ['ENGINEER'] });
    const eng = await login('deact@test.local');
    const admin = await login(ADMIN_EMAIL);
    const u = await User.findOne({ email: 'deact@test.local' }).lean();
    const r = await api(admin.token).post(`/users/${u!._id}/deactivate`).send({ reason: 'Left the company' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('INACTIVE');
    expect((await api(eng.token).get('/auth/me')).status).toBe(401);
  });
});

describe('AUTH-02 forgot / reset password', () => {
  it('does not reveal whether an email exists', async () => {
    const a = await request(getApp()).post('/api/v1/auth/forgot-password').send({ email: 'ghost@test.local' });
    const b = await request(getApp()).post('/api/v1/auth/forgot-password').send({ email: ADMIN_EMAIL });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body).toEqual(b.body);
  });

  it('resets the password with the single-use emailed token and revokes sessions', async () => {
    await createUser({ email: 'reset@test.local', roleKeys: ['ENGINEER'] });
    const old = await login('reset@test.local');
    const before = capturedMail().length;
    await request(getApp()).post('/api/v1/auth/forgot-password').send({ email: 'reset@test.local' });
    const mail = capturedMail().slice(before).find((m) => m.to === 'reset@test.local');
    expect(mail).toBeTruthy();
    const token = decodeURIComponent(/token=([^\s"&]+)/.exec(mail!.text)![1]);

    const newPassword = 'Brand-New-Passw0rd';
    const r = await request(getApp()).post('/api/v1/auth/reset-password').send({ token, password: newPassword, confirmPassword: newPassword });
    expect(r.status).toBe(200);
    expect((await api(old.token).get('/auth/me')).status).toBe(401);
    await login('reset@test.local', newPassword);

    const reuse = await request(getApp()).post('/api/v1/auth/reset-password').send({ token, password: newPassword, confirmPassword: newPassword });
    expect(reuse.status).toBe(400);
  });

  it('rejects weak passwords', async () => {
    const r = await request(getApp()).post('/api/v1/auth/reset-password').send({ token: 'x'.repeat(30), password: 'weak', confirmPassword: 'weak' });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.password).toBeTruthy();
  });
});

describe('forced password change restriction', () => {
  it('blocks normal endpoints until the password is changed', async () => {
    await createUser({ email: 'mustchange@test.local', roleKeys: ['SUPERVISOR'], mustChangePassword: true });
    const s = await login('mustchange@test.local');
    expect(s.body.user.mustChangePassword).toBe(true);
    const blocked = await api(s.token).get('/masters/regions');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await api(s.token).get('/auth/me')).status).toBe(200);
    const ch = await api(s.token)
      .post('/auth/change-password')
      .send({ currentPassword: PASSWORD, newPassword: 'Another-Passw0rd-1', confirmPassword: 'Another-Passw0rd-1' });
    expect(ch.status).toBe(200);
    expect((await api(s.token).get('/masters/regions')).status).toBe(200);
  });
});

describe('AUTH-05 MFA (TOTP)', () => {
  it('enrols, requires the second factor at login, and accepts a recovery code once', async () => {
    await createUser({ email: 'mfa@test.local', roleKeys: ['REVIEWER'] });
    const s = await login('mfa@test.local');
    const setup = await api(s.token).post('/auth/mfa/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const bad = await api(s.token).post('/auth/mfa/enable').send({ code: '000000' });
    expect(bad.status).toBe(400);
    const en = await api(s.token).post('/auth/mfa/enable').send({ code: authenticator.generate(setup.body.secret) });
    expect(en.status).toBe(200);
    expect(en.body.recoveryCodes).toHaveLength(10);

    // Secrets are never returned or stored in plain text.
    const stored = await User.findOne({ email: 'mfa@test.local' }).select('+mfa.secretEnc').lean();
    expect(stored!.mfa!.secretEnc).not.toContain(setup.body.secret);

    const step1 = await request(getApp()).post('/api/v1/auth/login').send({ identifier: 'mfa@test.local', password: PASSWORD });
    expect(step1.body.mfaRequired).toBe(true);
    expect(step1.body.accessToken).toBeUndefined();

    const wrong = await request(getApp()).post('/api/v1/auth/login/mfa').send({ challengeToken: step1.body.challengeToken, code: '123456' });
    expect(wrong.status).toBe(401);
    const ok = await request(getApp())
      .post('/api/v1/auth/login/mfa')
      .send({ challengeToken: step1.body.challengeToken, code: authenticator.generate(setup.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();

    const rc = en.body.recoveryCodes[0];
    const step2 = await request(getApp()).post('/api/v1/auth/login').send({ identifier: 'mfa@test.local', password: PASSWORD });
    const viaRc = await request(getApp()).post('/api/v1/auth/login/mfa').send({ challengeToken: step2.body.challengeToken, code: rc });
    expect(viaRc.status).toBe(200);
    const step3 = await request(getApp()).post('/api/v1/auth/login').send({ identifier: 'mfa@test.local', password: PASSWORD });
    const reuse = await request(getApp()).post('/api/v1/auth/login/mfa').send({ challengeToken: step3.body.challengeToken, code: rc });
    expect(reuse.status).toBe(401);
  });

  it('forces MFA setup for privileged roles when the policy is on', async () => {
    const admin = await login(ADMIN_EMAIL);
    const security = (await api(admin.token).get('/settings')).body.security;
    const on = await api(admin.token).put('/settings/security').send({ value: { ...security, mfaRequiredForPrivileged: true }, reason: 'test' });
    expect(on.status).toBe(200);
    try {
      await createUser({ email: 'priv@test.local', roleKeys: ['SUPERVISOR'] });
      const s = await login('priv@test.local');
      expect(s.body.user.mfaRequired).toBe(true);
      const blocked = await api(s.token).get('/masters/regions');
      expect(blocked.body.error.code).toBe('MFA_SETUP_REQUIRED');
      const setup = await api(s.token).post('/auth/mfa/setup');
      await api(s.token).post('/auth/mfa/enable').send({ code: authenticator.generate(setup.body.secret) });
      expect((await api(s.token).get('/masters/regions')).status).toBe(200);
      // Engineers are not privileged → no restriction.
      await createUser({ email: 'eng-nomfa@test.local', roleKeys: ['ENGINEER'] });
      const e = await login('eng-nomfa@test.local');
      expect((await api(e.token).get('/masters/regions')).status).toBe(200);
    } finally {
      await updateSettingsGroup({}, 'security', { ...security, mfaRequiredForPrivileged: false });
    }
  });
});
