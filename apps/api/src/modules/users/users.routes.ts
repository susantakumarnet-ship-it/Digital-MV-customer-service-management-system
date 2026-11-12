import { z } from 'zod';
import {
  paginationQuery,
  reasonBody,
  userAdminResetSchema,
  userCreateSchema,
  userListQuery,
  userRolesSchema,
  userScopeUpdateSchema,
  userUpdateSchema,
} from '@mv/shared';
import { ApiRouter, idParams } from '../../common/http/route';
import * as svc from './users.service';

export const usersRouter = new ApiRouter('/users', 'Users');

usersRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'List users (search, status, role, organization)',
    access: { permissions: ['user.read'] },
    query: userListQuery,
    handler: ({ auth, query }) => svc.listUsers(auth, query),
  })
  .route({
    method: 'post',
    path: '/',
    summary: 'Create a user. Without a password, an activation email is sent.',
    access: { permissions: ['user.create', 'user.administer'] },
    body: userCreateSchema,
    status: 201,
    handler: ({ body, ctx }) => svc.createUser(ctx, body),
  })
  .route({
    method: 'get',
    path: '/:id',
    summary: 'Get a user',
    access: { permissions: ['user.read'] },
    params: idParams,
    handler: ({ auth, params }) => svc.getUser(auth, params.id),
  })
  .route({
    method: 'patch',
    path: '/:id',
    summary: 'Update user profile fields',
    access: { permissions: ['user.update'] },
    params: idParams,
    body: userUpdateSchema,
    handler: ({ params, body, ctx }) => svc.updateUser(ctx, params.id, body),
  })
  .route({
    method: 'put',
    path: '/:id/roles',
    summary: 'Replace the user\'s roles (anti-escalation enforced)',
    access: { permissions: ['user.administer'] },
    params: idParams,
    body: userRolesSchema,
    handler: ({ params, body, ctx }) => svc.setUserRoles(ctx, params.id, body.roleIds),
  })
  .route({
    method: 'put',
    path: '/:id/scope',
    summary: 'Replace the user\'s data scope (organizations / regions / sites / global)',
    access: { permissions: ['user.update'] },
    params: idParams,
    body: userScopeUpdateSchema,
    handler: ({ params, body, ctx }) => svc.setUserScope(ctx, params.id, body.scope),
  })
  .route({
    method: 'post',
    path: '/:id/deactivate',
    summary: 'Deactivate a user (revokes all sessions)',
    access: { permissions: ['user.administer'] },
    params: idParams,
    body: reasonBody,
    handler: ({ params, body, ctx }) => svc.setUserActive(ctx, params.id, false, body.reason),
  })
  .route({
    method: 'post',
    path: '/:id/activate',
    summary: 'Re-activate a user',
    access: { permissions: ['user.administer'] },
    params: idParams,
    body: z.object({ reason: z.string().trim().max(1000).optional() }),
    handler: ({ params, body, ctx }) => svc.setUserActive(ctx, params.id, true, body.reason),
  })
  .route({
    method: 'post',
    path: '/:id/unlock',
    summary: 'Clear a login lockout',
    access: { permissions: ['user.administer'] },
    params: idParams,
    handler: ({ params, ctx }) => svc.unlockUser(ctx, params.id),
  })
  .route({
    method: 'post',
    path: '/:id/reset-password',
    summary: 'Set a password or email a reset link',
    access: { permissions: ['user.administer'] },
    params: idParams,
    body: userAdminResetSchema,
    handler: ({ params, body, ctx }) => svc.adminResetPassword(ctx, params.id, body.password, body.mustChangePassword),
  })
  .route({
    method: 'post',
    path: '/:id/mfa/reset',
    summary: 'Reset the user\'s MFA enrolment (lost device)',
    access: { permissions: ['user.administer'] },
    params: idParams,
    body: reasonBody,
    handler: ({ params, body, ctx }) => svc.resetUserMfa(ctx, params.id, body.reason),
  })
  .route({
    method: 'post',
    path: '/:id/sessions/revoke',
    summary: 'Sign the user out of all sessions',
    access: { permissions: ['user.administer'] },
    params: idParams,
    handler: ({ params, ctx }) => svc.revokeUserSessions(ctx, params.id),
  })
  .route({
    method: 'get',
    path: '/:id/login-activity',
    summary: 'Sign-in history for a user',
    access: { permissions: ['user.read', 'audit.read'] },
    params: idParams,
    query: paginationQuery,
    handler: ({ auth, params, query }) => svc.userLoginActivity(auth, params.id, query.page, query.limit),
  });
