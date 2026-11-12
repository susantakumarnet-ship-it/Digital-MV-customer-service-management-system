import { SYSTEM_ROLES } from '@mv/shared';
import { hashPassword } from '../../common/crypto';
import { ensureDefaultSettings } from '../../core/settings/settings.service';
import { DEFAULT_WORKFLOWS } from '../../core/workflow/workflow.definitions';
import { WorkflowDefinition } from '../../core/workflow/workflow.model';
import { Role } from '../../modules/roles/role.model';
import { User } from '../../modules/users/user.model';

type Log = (msg: string) => void;

/**
 * System roles. On first run each role gets its default permissions. On later runs, only permission
 * keys that are NEW in the code defaults (never seen before for that role) are added — permissions an
 * administrator deliberately removed are not re-added. `seededPermissions` tracks what was offered.
 */
export async function seedRoles(log: Log) {
  for (const def of SYSTEM_ROLES) {
    const existing = await Role.findOne({ key: def.key }).lean<{ _id: unknown; permissions: string[]; seededPermissions?: string[] }>();
    if (!existing) {
      await Role.collection.insertOne({
        key: def.key,
        name: def.name,
        description: def.description,
        permissions: def.permissions,
        seededPermissions: def.permissions,
        isSystem: true,
        assignable: def.assignable,
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      log(`  + role ${def.name}`);
      continue;
    }
    const offered = new Set(existing.seededPermissions ?? existing.permissions);
    const added = def.permissions.filter((p) => !offered.has(p));
    if (added.length) {
      await Role.collection.updateOne(
        { _id: existing._id as never },
        { $addToSet: { permissions: { $each: added }, seededPermissions: { $each: added } }, $set: { updatedAt: new Date() } },
      );
      log(`  ~ role ${def.name}: added new permissions ${added.join(', ')}`);
    }
  }
}

export async function seedWorkflows(log: Log) {
  for (const wf of DEFAULT_WORKFLOWS) {
    const existing = await WorkflowDefinition.findOne({ entity: wf.entity }).lean();
    if (!existing) {
      await WorkflowDefinition.create(wf);
      log(`  + workflow ${wf.entity}`);
    } else if (existing.version < wf.version) {
      log(`  ! workflow ${wf.entity} in DB is v${existing.version}, code default is v${wf.version} — apply via a migration`);
    }
  }
}

export async function seedAdmin(log: Log, email?: string, password?: string) {
  const adminRole = await Role.findOne({ key: 'ADMIN' }).lean();
  if (!adminRole) throw new Error('ADMIN role missing — seed roles first');
  const hasAdmin = await User.exists({ roleIds: adminRole._id, status: 'ACTIVE' });
  if (hasAdmin) {
    log('  = an active administrator already exists');
    return;
  }
  if (!email || !password) {
    throw new Error('No administrator exists. Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (min 12 chars, mixed case + digit) and re-run the seed.');
  }
  await User.create({
    name: 'System Administrator',
    email: email.toLowerCase(),
    username: 'admin',
    passwordHash: await hashPassword(password),
    roleIds: [adminRole._id],
    scope: { global: true, organizationIds: [], regionIds: [], siteIds: [] },
    status: 'ACTIVE',
    mustChangePassword: true,
  });
  log(`  + administrator ${email} (must change password at first sign-in)`);
}

export async function seedBase(log: Log, adminEmail?: string, adminPassword?: string) {
  log('Settings…');
  await ensureDefaultSettings();
  log('Roles…');
  await seedRoles(log);
  log('Workflows…');
  await seedWorkflows(log);
  log('Administrator…');
  await seedAdmin(log, adminEmail, adminPassword);
}
