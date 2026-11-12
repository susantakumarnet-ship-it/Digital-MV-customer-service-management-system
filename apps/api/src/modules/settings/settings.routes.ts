import { z } from 'zod';
import { AUDIT_ACTIONS, SETTINGS_GROUPS, WORKFLOW_ENTITIES, workflowUpdateSchema, type SettingsGroup } from '@mv/shared';
import { conflict, notFound, validationFailed } from '../../common/errors';
import { ApiRouter } from '../../common/http/route';
import { audit } from '../../core/audit/audit.service';
import { getSettings, updateSettingsGroup } from '../../core/settings/settings.service';
import { getDefinition, invalidateWorkflowCache, registeredGuards } from '../../core/workflow/workflow.engine';
import { WorkflowDefinition } from '../../core/workflow/workflow.model';
import { withTransaction } from '../../db/transaction';

export const settingsRouter = new ApiRouter('/settings', 'System configuration');

settingsRouter
  .route({
    method: 'get',
    path: '/public',
    summary: 'Public, non-sensitive settings (branding, timezone, public form notice)',
    access: { public: true },
    handler: async () => {
      const s = await getSettings();
      return {
        applicationName: s.general.applicationName,
        organizationName: s.general.organizationName,
        timezone: s.general.timezone,
        dateFormat: s.general.dateFormat,
        supportEmail: s.general.supportEmail,
        supportPhone: s.general.supportPhone,
        publicForm: {
          enabled: s.publicForm.enabled,
          privacyNoticeVersion: s.publicForm.privacyNoticeVersion,
          privacyNoticeText: s.publicForm.privacyNoticeText,
        },
        attachments: s.attachments,
      };
    },
  })
  .route({
    method: 'get',
    path: '/',
    summary: 'All configuration groups',
    access: { permissions: ['settings.read'] },
    handler: () => getSettings(),
  })
  .route({
    method: 'put',
    path: '/:group',
    summary: 'Replace one configuration group (validated, audited)',
    access: { permissions: ['settings.update'] },
    params: z.object({ group: z.enum(SETTINGS_GROUPS as [SettingsGroup, ...SettingsGroup[]]) }),
    body: z.object({ value: z.record(z.unknown()), reason: z.string().trim().max(1000).optional() }),
    handler: ({ params, body, ctx }) => updateSettingsGroup(ctx, params.group, body.value, body.reason),
  });

export const workflowsRouter = new ApiRouter('/workflows', 'Workflow configuration');

const entityParams = z.object({ entity: z.enum(WORKFLOW_ENTITIES) });

workflowsRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'All workflow definitions (states + transitions)',
    access: { anyOf: ['workflow.read', 'master.read'] },
    handler: async () => {
      const defs = await Promise.all(WORKFLOW_ENTITIES.map((e) => getDefinition(e).catch(() => null)));
      return { definitions: defs.filter(Boolean), guards: registeredGuards() };
    },
  })
  .route({
    method: 'get',
    path: '/:entity',
    summary: 'One workflow definition',
    access: { anyOf: ['workflow.read', 'master.read'] },
    params: entityParams,
    handler: ({ params }) => getDefinition(params.entity),
  })
  .route({
    method: 'patch',
    path: '/:entity',
    summary: 'Change status labels/colours and enable/disable OPTIONAL transitions',
    description: 'Mandatory transitions, guards and permissions are not editable (prevents bypassing business rules).',
    access: { permissions: ['workflow.update'] },
    params: entityParams,
    body: workflowUpdateSchema,
    handler: async ({ params, body, ctx }) => {
      const result = await withTransaction(async (session) => {
        const def = await WorkflowDefinition.findOne({ entity: params.entity }).session(session);
        if (!def) throw notFound('Workflow definition');
        const before = { states: def.states.map((s) => ({ key: s.key, label: s.label, tone: s.tone })), transitions: def.transitions.map((t) => ({ action: t.action, label: t.label, enabled: t.enabled })) };
        for (const s of body.states ?? []) {
          const st = def.states.find((x) => x.key === s.key);
          if (!st) throw validationFailed({ states: `Unknown state ${s.key}` });
          st.label = s.label;
          st.tone = s.tone;
        }
        for (const t of body.transitions ?? []) {
          const tr = def.transitions.find((x) => x.action === t.action);
          if (!tr) throw validationFailed({ transitions: `Unknown action ${t.action}` });
          if (tr.enabled !== t.enabled && !tr.optional) throw conflict(`"${tr.label}" is mandatory and cannot be disabled`, 'MANDATORY_TRANSITION');
          tr.label = t.label;
          tr.enabled = t.enabled;
        }
        def.version += 1;
        def.updatedBy = ctx.auth!.userId as never;
        await def.save({ session });
        await audit(
          ctx,
          {
            action: AUDIT_ACTIONS.WORKFLOW_CHANGED,
            entityType: 'workflowDefinition',
            entityId: def._id,
            entityRef: params.entity,
            before,
            after: { states: def.states.map((s) => ({ key: s.key, label: s.label, tone: s.tone })), transitions: def.transitions.map((t) => ({ action: t.action, label: t.label, enabled: t.enabled })) },
            reason: body.reason,
          },
          session,
        );
        return def.toObject();
      });
      invalidateWorkflowCache(params.entity);
      return getDefinition(params.entity).then((d) => d ?? result);
    },
  });
