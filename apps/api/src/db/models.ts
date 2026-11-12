/** Imports every model so migrations/seeds can operate on the full schema set. */
import { AuditLog } from '../core/audit/audit.model';
import { Counter } from '../core/counters/counter.service';
import { Notification } from '../core/notifications/notification.model';
import { SystemSetting } from '../core/settings/settings.model';
import { WorkflowDefinition } from '../core/workflow/workflow.model';
import { Session } from '../modules/auth/session.model';
import { OneTimeToken } from '../modules/auth/token.model';
import { MASTER_MODELS } from '../modules/masters/master.models';
import { Role } from '../modules/roles/role.model';
import { User } from '../modules/users/user.model';

export const ALL_MODELS = [
  AuditLog,
  Counter,
  Notification,
  SystemSetting,
  WorkflowDefinition,
  Session,
  OneTimeToken,
  Role,
  User,
  ...Object.values(MASTER_MODELS),
];
