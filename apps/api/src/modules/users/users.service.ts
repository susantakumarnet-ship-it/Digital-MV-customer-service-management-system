import { Types, type ClientSession } from 'mongoose';
import { AUDIT_ACTIONS, type UserCreateInput, type UserScope } from '@mv/shared';
import type { AuthContext, RequestContext } from '../../common/context';
import { escapeRegex, hashPassword } from '../../common/crypto';
import { conflict, forbidden, notFound, validationFailed } from '../../common/errors';
import { paged, parseSort } from '../../common/http/route';
import { AuditLog } from '../../core/audit/audit.model';
import { audit, diff } from '../../core/audit/audit.service';
import { notify } from '../../core/notifications/notification.service';
import { withTransaction } from '../../db/transaction';
import { revokeAllSessions, sendPasswordEmail } from '../auth/auth.service';
import { Session } from '../auth/session.model';
import { Organization, Region, Site } from '../masters/master.models';
import { Role } from '../roles/role.model';
import { User, toUserDto } from './user.model';

type Doc = Record<string, any>;

/** Non-global administrators only see/manage users of organisations in their own scope. */
function userVisibilityFilter(auth: AuthContext): Doc {
  if (auth.scope.global) return {};
  const orgs = auth.scope.organizationIds.map((o) => new Types.ObjectId(o));
  return { $or: [{ organizationId: { $in: orgs } }, { 'scope.organizationIds': { $in: orgs } }, { _id: new Types.ObjectId(auth.userId) }] };
}

async function loadVisibleUser(auth: AuthContext, id: string, session?: ClientSession) {
  const u = await User.findOne({ $and: [{ _id: id }, userVisibilityFilter(auth)] }).session(session ?? null);
  if (!u) throw notFound('User');
  return u;
}

/**
 * Anti-escalation: an administrator may only assign roles whose permissions they hold themselves,
 * and may only grant scope within their own scope.
 */
async function validateRoles(auth: AuthContext, roleIds: string[], session?: ClientSession) {
  const roles = await Role.find({ _id: { $in: roleIds } }).session(session ?? null).lean();
  if (roles.length !== new Set(roleIds).size) throw validationFailed({ roleIds: 'One or more roles do not exist' });
  for (const r of roles) {
    if (r.status !== 'ACTIVE') throw validationFailed({ roleIds: `Role "${r.name}" is inactive` });
    if (!r.assignable) throw validationFailed({ roleIds: `Role "${r.name}" cannot be assigned to user accounts` });
    const missing = (r.permissions ?? []).filter((p) => !auth.permissions.has(p as never));
    if (missing.length) throw forbidden(`You cannot assign the role "${r.name}" because it grants permissions you do not hold.`);
  }
  const isCustomer = roles.some((r) => r.key === 'CUSTOMER');
  if (isCustomer && roles.length > 1) {
    throw validationFailed({ roleIds: 'The Customer User role cannot be combined with internal roles' });
  }
  return { roles, isCustomer };
}

async function validateScope(auth: AuthContext, scope: UserScope, session?: ClientSession) {
  if (!auth.scope.global) {
    if (scope.global) throw forbidden('You cannot grant global data access');
    const outside = (list: string[], mine: string[]) => list.filter((x) => !mine.includes(x));
    if (
      outside(scope.organizationIds, auth.scope.organizationIds).length ||
      outside(scope.regionIds, auth.scope.regionIds).length ||
      outside(scope.siteIds, auth.scope.siteIds).length
    ) {
      throw forbidden('You can only grant access within your own data scope');
    }
  }
  const check = async (model: typeof Organization, ids: string[], field: string) => {
    if (!ids.length) return;
    const n = await model.countDocuments({ _id: { $in: ids } }).session(session ?? null);
    if (n !== new Set(ids).size) throw validationFailed({ [`scope.${field}`]: 'One or more selected records do not exist' });
  };
  await check(Organization, scope.organizationIds, 'organizationIds');
  await check(Region as unknown as typeof Organization, scope.regionIds, 'regionIds');
  await check(Site as unknown as typeof Organization, scope.siteIds, 'siteIds');
}

/** Customer users are always scoped to exactly their own organisation (D-02). */
function normaliseScope(isCustomer: boolean, organizationId: string | null | undefined, scope: UserScope): UserScope {
  if (!isCustomer) return scope;
  if (!organizationId) throw validationFailed({ organizationId: 'Customer users must belong to an organization' });
  return { global: false, organizationIds: [organizationId], regionIds: [], siteIds: [] };
}

/** Prevents removing the last active holder of the ADMIN role (lock-out protection). */
async function assertNotLastAdmin(userId: string, session?: ClientSession) {
  const admin = await Role.findOne({ key: 'ADMIN' }).session(session ?? null).lean();
  if (!admin) return;
  const others = await User.countDocuments({ _id: { $ne: userId }, roleIds: admin._id, status: 'ACTIVE' }).session(session ?? null);
  if (others === 0) throw conflict('This is the last active administrator. Assign another administrator first.', 'LAST_ADMIN');
}

async function isAdminHolder(roleIds: unknown[], session?: ClientSession) {
  const admin = await Role.findOne({ key: 'ADMIN' }).session(session ?? null).lean();
  return Boolean(admin && roleIds.map(String).includes(String(admin._id)));
}

export async function listUsers(
  auth: AuthContext,
  q: { page: number; limit: number; sort?: string; q?: string; status: string; roleId?: string; organizationId?: string },
) {
  const filter: Doc = {};
  if (q.status === 'LOCKED') {
    filter.status = 'ACTIVE';
    filter.lockedUntil = { $gt: new Date() };
  } else if (q.status !== 'ALL') filter.status = q.status;
  if (q.roleId) filter.roleIds = new Types.ObjectId(q.roleId);
  if (q.organizationId) filter.organizationId = new Types.ObjectId(q.organizationId);
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { username: rx }];
  }
  const full = { $and: [filter, userVisibilityFilter(auth)] };
  const sort = parseSort(q.sort, ['name', 'email', 'status', 'lastLoginAt', 'createdAt'], { name: 1 });
  const [rows, total] = await Promise.all([
    User.find(full)
      .sort(sort)
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate('roleIds', 'key name')
      .populate('organizationId', 'name code')
      .lean(),
    User.countDocuments(full),
  ]);
  return paged(rows.map(toUserDto), total, q.page, q.limit);
}

export async function getUser(auth: AuthContext, id: string) {
  const u = await loadVisibleUser(auth, id);
  await u.populate([
    { path: 'roleIds', select: 'key name' },
    { path: 'organizationId', select: 'name code' },
  ]);
  const activeSessions = await Session.countDocuments({ userId: u._id, revokedAt: null, expiresAt: { $gt: new Date() } });
  return { ...toUserDto(u.toObject()), activeSessions };
}

export async function createUser(ctx: RequestContext, input: UserCreateInput) {
  const auth = ctx.auth!;
  return withTransaction(async (session, afterCommit) => {
    const { isCustomer } = await validateRoles(auth, input.roleIds, session);
    if (input.organizationId) {
      const org = await Organization.findById(input.organizationId).session(session).lean();
      if (!org || org.status !== 'ACTIVE') throw validationFailed({ organizationId: 'Select an active organization' });
    }
    const scope = normaliseScope(isCustomer, input.organizationId, input.scope);
    await validateScope(auth, scope, session);

    const passwordHash = input.password ? await hashPassword(input.password) : undefined;
    const [user] = await User.create(
      [
        {
          name: input.name,
          email: input.email,
          username: input.username || undefined,
          phone: input.phone || undefined,
          jobTitle: input.jobTitle || undefined,
          roleIds: input.roleIds,
          organizationId: input.organizationId || undefined,
          scope,
          passwordHash,
          status: passwordHash ? 'ACTIVE' : 'PENDING_ACTIVATION',
          mustChangePassword: passwordHash ? input.mustChangePassword : false,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
      ],
      { session },
    );
    await audit(
      ctx,
      { action: AUDIT_ACTIONS.CREATE, entityType: 'user', entityId: user._id, entityRef: user.email, after: toUserDto(user.toObject()) },
      session,
    );
    if (!passwordHash) afterCommit(() => sendPasswordEmail(user, 'ACTIVATION', ctx));
    return toUserDto(user.toObject());
  });
}

export async function updateUser(ctx: RequestContext, id: string, input: Doc) {
  const auth = ctx.auth!;
  return withTransaction(async (session) => {
    const user = await loadVisibleUser(auth, id, session);
    const before = user.toObject();
    const roles = await Role.find({ _id: { $in: user.roleIds } }).session(session).lean();
    const isCustomer = roles.some((r) => r.key === 'CUSTOMER');
    if (input.organizationId !== undefined) {
      if (input.organizationId) {
        const org = await Organization.findById(input.organizationId).session(session).lean();
        if (!org || org.status !== 'ACTIVE') throw validationFailed({ organizationId: 'Select an active organization' });
      } else if (isCustomer) {
        throw validationFailed({ organizationId: 'Customer users must belong to an organization' });
      }
    }
    for (const k of ['name', 'email', 'username', 'phone', 'jobTitle', 'organizationId'] as const) {
      if (input[k] === undefined) continue;
      (user as Doc)[k] = input[k] === '' || input[k] === null ? undefined : input[k];
    }
    if (isCustomer && input.organizationId) user.scope = normaliseScope(true, input.organizationId, user.scope as never) as never;
    user.updatedBy = new Types.ObjectId(auth.userId) as never;
    await user.save({ session });
    const d = diff(before, user.toObject());
    if (d.changed.length) {
      await audit(ctx, { action: AUDIT_ACTIONS.UPDATE, entityType: 'user', entityId: user._id, entityRef: user.email, before: d.before, after: d.after }, session);
    }
    return toUserDto(user.toObject());
  });
}

export async function setUserRoles(ctx: RequestContext, id: string, roleIds: string[]) {
  const auth = ctx.auth!;
  return withTransaction(async (session) => {
    const user = await loadVisibleUser(auth, id, session);
    const { roles, isCustomer } = await validateRoles(auth, roleIds, session);
    // Also prevent removing roles the actor could not have granted.
    const removed = await Role.find({ _id: { $in: user.roleIds.filter((r) => !roleIds.includes(String(r))) } }).session(session).lean();
    for (const r of removed) {
      if ((r.permissions ?? []).some((p) => !auth.permissions.has(p as never))) {
        throw forbidden(`You cannot remove the role "${r.name}" because it grants permissions you do not hold.`);
      }
    }
    if ((await isAdminHolder(user.roleIds, session)) && !(await isAdminHolder(roleIds, session))) {
      await assertNotLastAdmin(String(user._id), session);
    }
    if (isCustomer && !user.organizationId) throw validationFailed({ roleIds: 'Set the user\'s organization before assigning the Customer User role' });
    const before = { roleIds: user.roleIds.map(String) };
    user.roleIds = roleIds.map((r) => new Types.ObjectId(r)) as never;
    if (isCustomer) user.scope = normaliseScope(true, String(user.organizationId), user.scope as never) as never;
    await user.save({ session });
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.USER_ROLES_CHANGED,
        entityType: 'user',
        entityId: user._id,
        entityRef: user.email,
        before,
        after: { roleIds, roles: roles.map((r) => r.name) },
      },
      session,
    );
    await notify(
      { recipientIds: [user._id], type: 'user.rolesChanged', title: 'Your access has changed', body: `Your roles are now: ${roles.map((r) => r.name).join(', ')}.` },
      session,
    );
    return toUserDto(user.toObject());
  });
}

export async function setUserScope(ctx: RequestContext, id: string, scope: UserScope) {
  const auth = ctx.auth!;
  return withTransaction(async (session) => {
    const user = await loadVisibleUser(auth, id, session);
    const roles = await Role.find({ _id: { $in: user.roleIds } }).session(session).lean();
    if (roles.some((r) => r.key === 'CUSTOMER')) {
      throw conflict("A customer user's scope is fixed to their organization", 'CUSTOMER_SCOPE_FIXED');
    }
    await validateScope(auth, scope, session);
    const before = user.toObject().scope;
    user.scope = scope as never;
    await user.save({ session });
    await audit(ctx, { action: AUDIT_ACTIONS.USER_SCOPE_CHANGED, entityType: 'user', entityId: user._id, entityRef: user.email, before, after: scope }, session);
    return toUserDto(user.toObject());
  });
}

export async function setUserActive(ctx: RequestContext, id: string, active: boolean, reason?: string) {
  const auth = ctx.auth!;
  if (!active && id === auth.userId) throw conflict('You cannot deactivate your own account', 'SELF_DEACTIVATION');
  const result = await withTransaction(async (session) => {
    const user = await loadVisibleUser(auth, id, session);
    if (!active && (await isAdminHolder(user.roleIds, session))) await assertNotLastAdmin(String(user._id), session);
    const before = { status: user.status };
    if (active) {
      if (user.status === 'ACTIVE') return toUserDto(user.toObject());
      // Users who never set a password go back to pending activation rather than active.
      const withHash = await User.findById(id).select('+passwordHash').session(session).lean();
      user.status = (withHash?.passwordHash ? 'ACTIVE' : 'PENDING_ACTIVATION') as never;
      user.deactivatedAt = undefined;
      user.deactivationReason = undefined;
    } else {
      user.status = 'INACTIVE' as never;
      user.deactivatedAt = new Date();
      user.deactivationReason = reason;
      await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'ACCOUNT_DEACTIVATED' } }, { session });
    }
    await user.save({ session });
    await audit(
      ctx,
      {
        action: active ? AUDIT_ACTIONS.ACTIVATE : AUDIT_ACTIONS.DEACTIVATE,
        entityType: 'user',
        entityId: user._id,
        entityRef: user.email,
        before,
        after: { status: user.status },
        reason,
      },
      session,
    );
    return toUserDto(user.toObject());
  });
  return result;
}

export async function unlockUser(ctx: RequestContext, id: string) {
  const user = await loadVisibleUser(ctx.auth!, id);
  await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0 }, $unset: { lockedUntil: 1 } });
  await audit(ctx, { action: 'user.unlocked', entityType: 'user', entityId: user._id, entityRef: user.email });
  return { ok: true };
}

export async function adminResetPassword(ctx: RequestContext, id: string, password: string | undefined, mustChangePassword: boolean) {
  const user = await loadVisibleUser(ctx.auth!, id);
  if (user.status === 'INACTIVE') throw conflict('Activate the account before resetting its password', 'USER_INACTIVE');
  if (password) {
    const passwordHash = await hashPassword(password);
    await withTransaction(async (session) => {
      await User.updateOne(
        { _id: user._id },
        {
          $set: { passwordHash, passwordChangedAt: new Date(), mustChangePassword, failedLoginCount: 0, status: 'ACTIVE' },
          $unset: { lockedUntil: 1 },
        },
        { session },
      );
      await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'ADMIN_PASSWORD_RESET' } }, { session });
      await audit(ctx, { action: AUDIT_ACTIONS.ADMIN_PASSWORD_RESET, entityType: 'user', entityId: user._id, entityRef: user.email, meta: { method: 'SET', mustChangePassword } }, session);
    });
    return { message: 'Password set. The user has been signed out of all sessions.' };
  }
  await sendPasswordEmail(user, user.status === 'PENDING_ACTIVATION' ? 'ACTIVATION' : 'PASSWORD_RESET', ctx);
  await audit(ctx, { action: AUDIT_ACTIONS.ADMIN_PASSWORD_RESET, entityType: 'user', entityId: user._id, entityRef: user.email, meta: { method: 'EMAIL_LINK' } });
  return { message: `A password link has been emailed to ${user.email}.` };
}

export async function resetUserMfa(ctx: RequestContext, id: string, reason: string) {
  const user = await loadVisibleUser(ctx.auth!, id);
  await User.updateOne(
    { _id: user._id },
    { $set: { 'mfa.enabled': false, 'mfa.recoveryCodeHashes': [] }, $unset: { 'mfa.secretEnc': 1, 'mfa.pendingSecretEnc': 1, 'mfa.enabledAt': 1 } },
  );
  await revokeAllSessions(String(user._id), 'MFA_RESET');
  await audit(ctx, { action: 'user.mfa.adminReset', entityType: 'user', entityId: user._id, entityRef: user.email, reason });
  return { ok: true };
}

export async function revokeUserSessions(ctx: RequestContext, id: string) {
  const user = await loadVisibleUser(ctx.auth!, id);
  await revokeAllSessions(String(user._id), 'ADMIN_REVOKED');
  await audit(ctx, { action: AUDIT_ACTIONS.SESSION_REVOKED, entityType: 'user', entityId: user._id, entityRef: user.email, meta: { all: true } });
  return { ok: true };
}

export async function userLoginActivity(auth: AuthContext, id: string, page: number, limit: number) {
  const user = await loadVisibleUser(auth, id);
  const filter = { action: { $regex: '^auth\\.' }, $or: [{ actorId: user._id }, { entityId: user._id }] };
  const [rows, total] = await Promise.all([
    AuditLog.find(filter).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).select('action outcome ip userAgent timestamp meta').lean(),
    AuditLog.countDocuments(filter),
  ]);
  return paged(
    rows.map((r) => ({ id: String(r._id), action: r.action, outcome: r.outcome, ip: r.ip, userAgent: r.userAgent, timestamp: r.timestamp, meta: r.meta })),
    total,
    page,
    limit,
  );
}
