import { Types } from 'mongoose';
import type { PermissionKey } from '@mv/shared';
import { Role } from '../../modules/roles/role.model';
import { User } from '../../modules/users/user.model';

/**
 * Active users holding `permission` whose data scope covers the given location (or who are global).
 * Used to route notifications to the right queue owners (e.g. supervisors for a new complaint).
 */
export async function usersWithPermissionInScope(
  permission: PermissionKey,
  location: { organizationId?: unknown; regionId?: unknown; siteId?: unknown },
) {
  const roles = await Role.find({ status: 'ACTIVE', permissions: permission }).select('_id').lean();
  if (!roles.length) return [];
  const or: Record<string, unknown>[] = [{ 'scope.global': true }];
  if (location.organizationId) or.push({ 'scope.organizationIds': new Types.ObjectId(String(location.organizationId)) });
  if (location.regionId) or.push({ 'scope.regionIds': new Types.ObjectId(String(location.regionId)) });
  if (location.siteId) or.push({ 'scope.siteIds': new Types.ObjectId(String(location.siteId)) });
  return User.find({ status: 'ACTIVE', roleIds: { $in: roles.map((r) => r._id) }, $or: or })
    .select('_id name email')
    .lean();
}
