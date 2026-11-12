import mongoose from 'mongoose';
import { MASTER_KEYS, MASTER_RESOURCES } from '@mv/shared';
import { ApiRouter } from '../../common/http/route';
import { AuditLog } from '../../core/audit/audit.model';
import { Session } from '../auth/session.model';
import { MASTER_MODELS } from '../masters/master.models';
import { Role } from '../roles/role.model';
import { User } from '../users/user.model';

/**
 * Dashboard data. Every figure is computed from the database (BRF §27.6).
 * Phase 2 provides the platform figures; complaint/work-order/NCR KPIs are added by the phases
 * that introduce those collections (counts for not-yet-existing collections are not shown).
 */
async function collectionCount(name: string, filter: Record<string, unknown> = {}) {
  const db = mongoose.connection.db;
  if (!db) return null;
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  return exists ? db.collection(name).countDocuments(filter) : null;
}

export const dashboardRouter = new ApiRouter('/dashboard', 'Dashboards');

dashboardRouter.route({
  method: 'get',
  path: '/admin',
  summary: 'Administrator dashboard: platform health, users, master data, security events',
  access: { permissions: ['dashboard.admin'] },
  handler: async () => {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 3600_000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);

    const [usersByStatus, locked, activeSessions, roles, masterCounts, failures24h, logins7d, recentEvents, roleDistribution] =
      await Promise.all([
        User.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
        User.countDocuments({ status: 'ACTIVE', lockedUntil: { $gt: now } }),
        Session.countDocuments({ revokedAt: null, expiresAt: { $gt: now }, lastSeenAt: { $gt: dayAgo } }),
        Role.countDocuments({ status: 'ACTIVE' }),
        Promise.all(
          MASTER_KEYS.map(async (k) => ({
            key: k,
            label: MASTER_RESOURCES[k].label,
            active: await MASTER_MODELS[k].countDocuments({ status: 'ACTIVE' }),
            inactive: await MASTER_MODELS[k].countDocuments({ status: 'INACTIVE' }),
          })),
        ),
        AuditLog.countDocuments({ action: { $in: ['auth.login.failure', 'auth.login.locked'] }, timestamp: { $gte: dayAgo } }),
        AuditLog.aggregate<{ _id: { day: string; outcome: string }; n: number }>([
          { $match: { action: { $in: ['auth.login.success', 'auth.login.failure', 'auth.login.locked'] }, timestamp: { $gte: weekAgo } } },
          {
            $group: {
              _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, outcome: '$outcome' },
              n: { $sum: 1 },
            },
          },
          { $sort: { '_id.day': 1 } },
        ]),
        AuditLog.find({ action: { $not: /^auth\.login\.success$/ } })
          .sort({ timestamp: -1 })
          .limit(10)
          .select('timestamp actorName action entityType entityRef outcome')
          .lean(),
        User.aggregate<{ _id: string; n: number }>([
          { $match: { status: { $ne: 'INACTIVE' } } },
          { $unwind: '$roleIds' },
          { $lookup: { from: 'roles', localField: 'roleIds', foreignField: '_id', as: 'role' } },
          { $unwind: '$role' },
          { $group: { _id: '$role.name', n: { $sum: 1 } } },
          { $sort: { n: -1 } },
        ]),
      ]);

    // Operational KPIs: populated automatically as later phases create these collections.
    const operational = {
      complaints: await collectionCount('complaints'),
      workOrders: await collectionCount('workOrders'),
      materialRequests: await collectionCount('materialRequests'),
      ncrs: await collectionCount('ncrs'),
    };

    const statusMap = Object.fromEntries(usersByStatus.map((s) => [s._id, s.n]));
    const days: { day: string; success: number; failure: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 3600_000).toISOString().slice(0, 10);
      days.push({
        day: d,
        success: logins7d.find((x) => x._id.day === d && x._id.outcome === 'SUCCESS')?.n ?? 0,
        failure: logins7d.find((x) => x._id.day === d && x._id.outcome === 'FAILURE')?.n ?? 0,
      });
    }

    return {
      users: {
        total: usersByStatus.reduce((a, s) => a + s.n, 0),
        active: (statusMap.ACTIVE ?? 0) - locked,
        inactive: statusMap.INACTIVE ?? 0,
        pendingActivation: statusMap.PENDING_ACTIVATION ?? 0,
        locked,
      },
      activeSessions24h: activeSessions,
      roles,
      loginFailures24h: failures24h,
      loginTrend: days,
      roleDistribution: roleDistribution.map((r) => ({ role: r._id, users: r.n })),
      masterData: masterCounts,
      operational,
      recentEvents: recentEvents.map((e) => ({
        id: String(e._id),
        timestamp: e.timestamp,
        actorName: e.actorName ?? 'System',
        action: e.action,
        entityType: e.entityType,
        entityRef: e.entityRef ?? null,
        outcome: e.outcome,
      })),
    };
  },
});
