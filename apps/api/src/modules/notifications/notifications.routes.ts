import { z } from 'zod';
import { paginationQuery } from '@mv/shared';
import { notFound } from '../../common/errors';
import { ApiRouter, idParams, paged } from '../../common/http/route';
import { Notification } from '../../core/notifications/notification.model';

export const notificationsRouter = new ApiRouter('/notifications', 'Notifications');

notificationsRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'My in-app notifications',
    access: { permissions: ['notification.read'] },
    query: paginationQuery.extend({ unread: z.enum(['true', 'false']).optional() }),
    handler: async ({ auth, query }) => {
      const filter: Record<string, unknown> = { recipientId: auth.userId, channel: 'IN_APP' };
      if (query.unread === 'true') filter.readAt = null;
      const [rows, total] = await Promise.all([
        Notification.find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
        Notification.countDocuments(filter),
      ]);
      return paged(
        rows.map((n) => ({
          id: String(n._id),
          type: n.type,
          title: n.title,
          body: n.body,
          link: n.link ?? null,
          severity: n.severity,
          readAt: n.readAt ?? null,
          createdAt: n.createdAt,
        })),
        total,
        query.page,
        query.limit,
      );
    },
  })
  .route({
    method: 'get',
    path: '/unread-count',
    summary: 'Number of unread in-app notifications',
    access: { permissions: ['notification.read'] },
    handler: async ({ auth }) => ({
      count: await Notification.countDocuments({ recipientId: auth.userId, channel: 'IN_APP', readAt: null }),
    }),
  })
  .route({
    method: 'post',
    path: '/:id/read',
    summary: 'Mark one notification as read',
    access: { permissions: ['notification.read'] },
    params: idParams,
    handler: async ({ auth, params }) => {
      const n = await Notification.findOneAndUpdate(
        { _id: params.id, recipientId: auth.userId },
        { $set: { readAt: new Date() } },
        { new: true },
      );
      if (!n) throw notFound('Notification');
      return { ok: true };
    },
  })
  .route({
    method: 'post',
    path: '/read-all',
    summary: 'Mark all my notifications as read',
    access: { permissions: ['notification.read'] },
    handler: async ({ auth }) => {
      const r = await Notification.updateMany({ recipientId: auth.userId, channel: 'IN_APP', readAt: null }, { $set: { readAt: new Date() } });
      return { updated: r.modifiedCount };
    },
  });
