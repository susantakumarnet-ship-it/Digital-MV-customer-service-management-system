import multer from 'multer';
import { z } from 'zod';
import { MASTER_KEYS, MASTER_RESOURCES, masterListQuery, masterOptionsQuery, objectId } from '@mv/shared';
import { badRequest } from '../../common/errors';
import { ApiRouter } from '../../common/http/route';
import * as svc from './masters.service';

const resourceParams = z.object({ resource: z.enum(MASTER_KEYS) });
const resourceIdParams = resourceParams.extend({ id: objectId });
const statusBody = z.object({ reason: z.string().trim().max(1000).optional() });
const deactivateBody = z.object({ reason: z.string().trim().min(1, 'A reason is required').max(1000) });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/\.(xlsx|csv)$/i.test(file.originalname)) cb(null, true);
    else cb(badRequest('Upload a .xlsx or .csv file'));
  },
});

export const mastersRouter = new ApiRouter('/masters', 'Master data');

mastersRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'Master data resource definitions (fields, refs, groups)',
    access: { permissions: ['master.read'] },
    handler: () => MASTER_KEYS.map((k) => MASTER_RESOURCES[k]),
  })
  .route({
    method: 'get',
    path: '/:resource',
    summary: 'List master records (search, status, parent filter, pagination)',
    access: { permissions: ['master.read'] },
    params: resourceParams,
    query: masterListQuery,
    handler: ({ params, query }) => svc.listMasters(params.resource, query),
  })
  .route({
    method: 'get',
    path: '/:resource/options',
    summary: 'Dropdown options (active records) with parent ids for cascading selects',
    access: { permissions: ['master.read'] },
    params: resourceParams,
    query: masterOptionsQuery,
    handler: ({ params, query }) => svc.masterOptions(params.resource, query),
  })
  .route({
    method: 'get',
    path: '/:resource/import-template',
    summary: 'Download the bulk-import template (xlsx or csv)',
    access: { permissions: ['master.import'] },
    params: resourceParams,
    query: z.object({ format: z.enum(['xlsx', 'csv']).default('xlsx') }),
    raw: true,
    handler: async ({ params, query, res }) => {
      const buf = await svc.importTemplate(params.resource, query.format);
      res.setHeader(
        'Content-Type',
        query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${params.resource}-template.${query.format}"`);
      res.send(buf);
    },
  })
  .route({
    method: 'post',
    path: '/:resource/import',
    summary: 'Bulk import (multipart field "file"). dryRun=true validates only; otherwise all-or-nothing commit.',
    access: { permissions: ['master.import', 'master.create', 'master.update'] },
    params: resourceParams,
    query: z.object({ dryRun: z.enum(['true', 'false']).default('true').transform((v) => v === 'true') }),
    middleware: [upload.single('file')],
    multipart: true,
    handler: async ({ req, params, query, ctx }) => {
      if (!req.file) throw badRequest('Attach a file in the "file" field');
      return svc.importMasters(ctx, params.resource, req.file.buffer, req.file.originalname, query.dryRun);
    },
  })
  .route({
    method: 'get',
    path: '/:resource/:id',
    summary: 'Get one master record',
    access: { permissions: ['master.read'] },
    params: resourceIdParams,
    handler: ({ params }) => svc.getMaster(params.resource, params.id),
  })
  .route({
    method: 'post',
    path: '/:resource',
    summary: 'Create a master record',
    access: { permissions: ['master.create'] },
    params: resourceParams,
    status: 201,
    handler: ({ params, req, ctx }) => svc.createMaster(ctx, params.resource, req.body),
  })
  .route({
    method: 'patch',
    path: '/:resource/:id',
    summary: 'Update a master record (partial)',
    access: { permissions: ['master.update'] },
    params: resourceIdParams,
    handler: ({ params, req, ctx }) => svc.updateMaster(ctx, params.resource, params.id, req.body),
  })
  .route({
    method: 'post',
    path: '/:resource/:id/deactivate',
    summary: 'Deactivate (records are never deleted — BR-018)',
    access: { permissions: ['master.update'] },
    params: resourceIdParams,
    body: deactivateBody,
    handler: ({ params, body, ctx }) => svc.setMasterStatus(ctx, params.resource, params.id, 'INACTIVE', body.reason),
  })
  .route({
    method: 'post',
    path: '/:resource/:id/activate',
    summary: 'Re-activate a master record',
    access: { permissions: ['master.update'] },
    params: resourceIdParams,
    body: statusBody,
    handler: ({ params, body, ctx }) => svc.setMasterStatus(ctx, params.resource, params.id, 'ACTIVE', body.reason),
  });
