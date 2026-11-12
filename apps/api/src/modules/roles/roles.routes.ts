import { z } from 'zod';
import { AUDIT_ACTIONS, PERMISSION_CATALOG, queryBool, roleCreateSchema, roleUpdateSchema, type PermissionKey } from '@mv/shared';
import type { RequestContext } from '../../common/context';
import { conflict, forbidden, notFound } from '../../common/errors';
import { ApiRouter, idParams } from '../../common/http/route';
import { audit } from '../../core/audit/audit.service';
import { withTransaction } from '../../db/transaction';
import { User } from '../users/user.model';
import { Role } from './role.model';

/** Permissions the ADMIN role must always keep so the system can never be locked out. */
const ADMIN_FLOOR: PermissionKey[] = ['role.read', 'role.update', 'user.read', 'user.administer', 'settings.read', 'settings.update'];

function assertCanGrant(ctx: RequestContext, permissions: string[]) {
  const missing = permissions.filter((p) => !ctx.auth!.permissions.has(p as never));
  if (missing.length) throw forbidden(`You cannot grant permissions you do not hold: ${missing.join(', ')}`);
}

async function roleDto(r: Record<string, any>) {
  const userCount = await User.countDocuments({ roleIds: r._id, status: { $ne: 'INACTIVE' } });
  return {
    id: String(r._id),
    key: r.key ?? null,
    name: r.name,
    description: r.description ?? '',
    permissions: r.permissions ?? [],
    isSystem: Boolean(r.isSystem),
    assignable: r.assignable !== false,
    status: r.status,
    userCount,
    updatedAt: r.updatedAt,
  };
}

export const rolesRouter = new ApiRouter('/roles', 'Roles & permissions');

rolesRouter
  .route({
    method: 'get',
    path: '/permissions',
    summary: 'Permission catalogue (modules and actions)',
    access: { permissions: ['role.read'] },
    handler: () => PERMISSION_CATALOG,
  })
  .route({
    method: 'get',
    path: '/',
    summary: 'List roles with user counts',
    access: { anyOf: ['role.read', 'user.read'] },
    query: z.object({ includeInactive: queryBool }),
    handler: async ({ query }) => {
      const rows = await Role.find(query.includeInactive ? {} : { status: 'ACTIVE' }).sort({ isSystem: -1, name: 1 }).lean();
      return Promise.all(rows.map(roleDto));
    },
  })
  .route({
    method: 'get',
    path: '/:id',
    summary: 'Get a role',
    access: { permissions: ['role.read'] },
    params: idParams,
    handler: async ({ params }) => {
      const r = await Role.findById(params.id).lean();
      if (!r) throw notFound('Role');
      return roleDto(r);
    },
  })
  .route({
    method: 'post',
    path: '/',
    summary: 'Create a custom role',
    access: { permissions: ['role.create'] },
    body: roleCreateSchema,
    status: 201,
    handler: async ({ body, ctx }) => {
      assertCanGrant(ctx, body.permissions);
      return withTransaction(async (session) => {
        const [r] = await Role.create(
          [{ name: body.name, description: body.description || undefined, permissions: body.permissions, isSystem: false, createdBy: ctx.auth!.userId }],
          { session },
        );
        await audit(ctx, { action: AUDIT_ACTIONS.CREATE, entityType: 'role', entityId: r._id, entityRef: r.name, after: r.toObject() }, session);
        return roleDto(r.toObject());
      });
    },
  })
  .route({
    method: 'patch',
    path: '/:id',
    summary: 'Update a role (name, description, permissions)',
    access: { permissions: ['role.update'] },
    params: idParams,
    body: roleUpdateSchema.extend({ reason: z.string().trim().max(1000).optional() }),
    handler: async ({ params, body, ctx }) =>
      withTransaction(async (session) => {
        const r = await Role.findById(params.id).session(session);
        if (!r) throw notFound('Role');
        if (r.key === 'PUBLIC_REPORTER') throw conflict('The Public Reporter role represents unauthenticated access and cannot be edited', 'ROLE_LOCKED');
        if (r.isSystem && body.name && body.name !== r.name) throw conflict('System role names cannot be changed', 'SYSTEM_ROLE');
        const before = { name: r.name, description: r.description, permissions: [...r.permissions] };

        if (body.permissions) {
          const added = body.permissions.filter((p) => !r.permissions.includes(p));
          const removed = r.permissions.filter((p) => !body.permissions!.includes(p));
          // Anti-escalation in both directions.
          assertCanGrant(ctx, [...added, ...removed]);
          if (r.key === 'ADMIN') {
            const lost = ADMIN_FLOOR.filter((p) => !body.permissions!.includes(p));
            if (lost.length) throw conflict(`The Administrator role must keep: ${lost.join(', ')}`, 'ADMIN_FLOOR');
          }
          r.permissions = body.permissions;
        }
        if (body.name) r.name = body.name;
        if (body.description !== undefined) r.description = body.description || undefined;
        r.updatedBy = ctx.auth!.userId as never;
        await r.save({ session });

        const permsChanged = JSON.stringify(before.permissions) !== JSON.stringify(r.permissions);
        await audit(
          ctx,
          {
            action: permsChanged ? AUDIT_ACTIONS.ROLE_PERMISSIONS_CHANGED : AUDIT_ACTIONS.UPDATE,
            entityType: 'role',
            entityId: r._id,
            entityRef: r.name,
            before: permsChanged
              ? { removed: before.permissions.filter((p) => !r.permissions.includes(p)) }
              : { name: before.name, description: before.description },
            after: permsChanged
              ? { added: r.permissions.filter((p) => !before.permissions.includes(p)) }
              : { name: r.name, description: r.description },
            reason: body.reason,
          },
          session,
        );
        return roleDto(r.toObject());
      }),
  })
  .route({
    method: 'post',
    path: '/:id/deactivate',
    summary: 'Deactivate a custom role (must have no active users)',
    access: { permissions: ['role.update'] },
    params: idParams,
    body: z.object({ reason: z.string().trim().min(1, 'A reason is required').max(1000) }),
    handler: async ({ params, body, ctx }) => {
      const r = await Role.findById(params.id);
      if (!r) throw notFound('Role');
      if (r.isSystem) throw conflict('System roles cannot be deactivated', 'SYSTEM_ROLE');
      const users = await User.countDocuments({ roleIds: r._id, status: { $ne: 'INACTIVE' } });
      if (users) throw conflict(`Remove this role from ${users} user(s) before deactivating it`, 'ROLE_IN_USE');
      r.status = 'INACTIVE';
      await r.save();
      await audit(ctx, { action: AUDIT_ACTIONS.DEACTIVATE, entityType: 'role', entityId: r._id, entityRef: r.name, reason: body.reason });
      return roleDto(r.toObject());
    },
  })
  .route({
    method: 'post',
    path: '/:id/activate',
    summary: 'Re-activate a custom role',
    access: { permissions: ['role.update'] },
    params: idParams,
    handler: async ({ params, ctx }) => {
      const r = await Role.findById(params.id);
      if (!r) throw notFound('Role');
      assertCanGrant(ctx, r.permissions);
      r.status = 'ACTIVE';
      await r.save();
      await audit(ctx, { action: AUDIT_ACTIONS.ACTIVATE, entityType: 'role', entityId: r._id, entityRef: r.name });
      return roleDto(r.toObject());
    },
  });
