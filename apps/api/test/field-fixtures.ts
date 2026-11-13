import request from 'supertest';
import { expect } from 'vitest';
import { intake, type Locations } from './fixtures';
import { api, getApp } from './helpers';

const key = () => `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}xx`;

/** Complaint → classified → work order assigned to `engineerIds` → accepted by each `acceptBy` token. */
export async function acceptedWorkOrder(
  L: Locations,
  supToken: string,
  engineerIds: string[],
  acceptBy: string[],
  extra: Record<string, unknown> = {},
) {
  const c = await request(getApp())
    .post('/api/v1/complaints')
    .set('Authorization', `Bearer ${supToken}`)
    .set('Idempotency-Key', key())
    .field('data', JSON.stringify({ ...intake(L), source: 'PHONE' }));
  expect(c.status).toBe(201);
  const cl = await api(supToken).put(`/complaints/${c.body.id}/classification`).send({ requestTypeId: String(L.requestType._id), priorityId: String(L.p1._id) });
  expect(cl.status).toBe(200);
  const wo = await api(supToken)
    .post(`/complaints/${c.body.id}/work-orders`)
    .send({ title: 'Field work', description: 'Inspect and repair', assigneeIds: engineerIds, assetId: undefined, ...extra });
  expect(wo.status).toBe(201);
  for (const t of acceptBy) expect((await api(t).post(`/work-orders/${wo.body.id}/transitions`).send({ action: 'accept' })).status).toBe(200);
  return { complaintId: c.body.id as string, workOrderId: wo.body.id as string, workOrderNo: wo.body.workOrderNo as string };
}

export async function newVisit(token: string, workOrderId: string, body: Record<string, unknown> = {}) {
  const r = await api(token).post(`/work-orders/${workOrderId}/visits`).send({ purpose: 'Inspect RMU and restore supply', ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

export function record(token: string, visitId: string, eventType: string, extra: Record<string, unknown> = {}, idemKey?: string) {
  let r = api(token).post(`/visits/${visitId}/time-events`);
  if (idemKey) r = r.set('Idempotency-Key', idemKey);
  return r.send({ eventType, ...extra });
}

export const SIX = ['START_TRAVEL', 'ARRIVE_SITE', 'START_WORK', 'END_WORK', 'START_RETURN', 'ARRIVE_BASE'];

export async function recordUpTo(token: string, visitId: string, last: string) {
  for (const e of SIX) {
    const r = await record(token, visitId, e);
    expect(r.status, `${e}: ${JSON.stringify(r.body)}`).toBe(200);
    if (e === last) return r.body;
  }
  throw new Error('unreachable');
}
