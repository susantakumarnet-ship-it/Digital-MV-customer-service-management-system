import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit/audit.model';
import { Notification } from '../src/core/notifications/notification.model';
import { transition } from '../src/core/workflow/workflow.engine';
import { InventoryItem, Warehouse } from '../src/modules/masters/master.models';
import { StockBalance, StockTransaction } from '../src/modules/materials/material.models';
import { acceptedWorkOrder } from './field-fixtures';
import { PNG, seedLocations, type Locations } from './fixtures';
import { api, bootstrap, createUser, getApp, login } from './helpers';

let L: Locations;
let sup: string;
let store: string;
let eng: string;
let engB: string;
let dual: string; // engineer + supervisor
const ids: Record<string, string> = {};
let wo: Awaited<ReturnType<typeof acceptedWorkOrder>>;

const bal = async (itemId: string, warehouseId: string) => (await StockBalance.findOne({ itemId, warehouseId }).lean()) ?? { onHand: 0, reserved: 0 };

beforeAll(async () => {
  await bootstrap();
  L = await seedLocations();
  ids.w1 = String((await Warehouse.create({ name: 'Central Store', code: 'WH1' }))._id);
  ids.w2 = String((await Warehouse.create({ name: 'North Store', code: 'WH2' }))._id);
  ids.fuse = String((await InventoryItem.create({ name: 'HRC Fuse 63A', code: 'FUSE63', unit: 'EA', reorderLevel: 3 }))._id);
  ids.cable = String((await InventoryItem.create({ name: 'MV cable 95mm²', code: 'CBL95', unit: 'M' }))._id);
  ids.old = String((await InventoryItem.create({ name: 'Obsolete part', code: 'OLD1', unit: 'EA', status: 'INACTIVE' }))._id);
  await createUser({ email: 'msup@test.local', roleKeys: ['SUPERVISOR'], scope: { global: true } });
  await createUser({ email: 'mstore@test.local', roleKeys: ['STOREKEEPER'], scope: { global: true } });
  const e = await createUser({ email: 'meng@test.local', roleKeys: ['ENGINEER'], scope: { regionIds: [String(L.A.region._id)] } });
  const d = await createUser({ email: 'mdual@test.local', roleKeys: ['ENGINEER', 'SUPERVISOR'], scope: { regionIds: [String(L.A.region._id)] } });
  await createUser({ email: 'mengB@test.local', roleKeys: ['ENGINEER'], scope: { regionIds: [String(L.B.region._id)] } });
  ids.eng = String(e._id);
  ids.dual = String(d._id);
  sup = (await login('msup@test.local')).token;
  store = (await login('mstore@test.local')).token;
  eng = (await login('meng@test.local')).token;
  dual = (await login('mdual@test.local')).token;
  engB = (await login('mengB@test.local')).token;
  wo = await acceptedWorkOrder(L, sup, [ids.eng, ids.dual], [eng, dual]);
});

describe('MAT-05 receipts, adjustments and the immutable ledger', () => {
  it('receives stock and opening balances into separate warehouses', async () => {
    const r1 = await api(store).post('/inventory/receipts').send({ warehouseId: ids.w1, type: 'RECEIPT', reference: 'PO-1001', lines: [{ itemId: ids.fuse, quantity: 10, batchNo: 'B-7' }, { itemId: ids.cable, quantity: 250 }] });
    expect(r1.status).toBe(201);
    expect((await api(store).post('/inventory/receipts').send({ warehouseId: ids.w2, type: 'OPENING', lines: [{ itemId: ids.fuse, quantity: 5 }] })).status).toBe(201);
    expect(await bal(ids.fuse, ids.w1)).toMatchObject({ onHand: 10, reserved: 0 });
    expect(await bal(ids.fuse, ids.w2)).toMatchObject({ onHand: 5 });
    const list = await api(store).get(`/inventory/balances?itemId=${ids.fuse}`);
    expect(list.body.data.map((b: any) => [b.warehouse.code, b.available, b.lowStock])).toEqual([
      ['WH1', 10, false],
      ['WH2', 5, false],
    ]);
  });

  it('adjustments need a reason and can never take stock below zero', async () => {
    expect((await api(store).post('/inventory/adjustments').send({ warehouseId: ids.w2, itemId: ids.fuse, delta: -1 })).status).toBe(400);
    const tooMuch = await api(store).post('/inventory/adjustments').send({ warehouseId: ids.w2, itemId: ids.fuse, delta: -50, reason: 'Count' });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_STOCK');
    const ok = await api(store).post('/inventory/adjustments').send({ warehouseId: ids.w2, itemId: ids.fuse, delta: -2, reason: 'Stock count variance' });
    expect(ok.body).toMatchObject({ onHand: 3 });
    expect(await AuditLog.countDocuments({ action: 'inventory.adjusted' })).toBe(1);
    // Now at the reorder level → flagged.
    const low = await api(store).get('/inventory/balances?lowStock=true');
    expect(low.body.data.map((b: any) => b.warehouse.code)).toEqual(['WH2']);
    expect((await api(eng).post('/inventory/adjustments').send({ warehouseId: ids.w2, itemId: ids.fuse, delta: 5, reason: 'x' })).status).toBe(403);
  });

  it('ledger entries cannot be modified or deleted', async () => {
    await expect(StockTransaction.updateOne({}, { $set: { quantity: 999 } })).rejects.toThrow(/immutable/);
    await expect(StockTransaction.deleteMany({})).rejects.toThrow(/immutable/);
    const t = await StockTransaction.findOne({});
    t!.quantity = 1;
    await expect(t!.save()).rejects.toThrow(/immutable/);
  });
});

describe('MAT-01/02 request and decision', () => {
  let mr: any;
  it('only assigned engineers raise requests, for active catalogue items', async () => {
    expect((await api(engB).post('/material-requests').send({ workOrderId: wo.workOrderId, reason: 'Need fuses', lines: [{ itemId: ids.fuse, quantity: 8 }] })).status).toBe(404);
    const inactive = await api(eng).post('/material-requests').send({ workOrderId: wo.workOrderId, reason: 'Need parts', lines: [{ itemId: ids.old, quantity: 1 }] });
    expect(inactive.status).toBe(400);
    const r = await api(eng).post('/material-requests').send({ workOrderId: wo.workOrderId, urgency: 'HIGH', reason: 'Blown fuses on feeder 2', lines: [{ itemId: ids.fuse, quantity: 8, reason: 'Replace all phases' }] });
    expect(r.status).toBe(201);
    mr = r.body;
    expect(mr).toMatchObject({ status: 'SUBMITTED', urgency: 'HIGH', lineCount: 1 });
    expect(mr.requestNo).toMatch(/^MR-\d{4}-\d{6}$/);
    expect(mr.lines[0]).toMatchObject({ quantity: 8, approvedQty: null, item: { code: 'FUSE63', unit: 'EA' } });
    expect(await Notification.countDocuments({ type: 'materialRequest.submitted', entityId: mr.id })).toBeGreaterThanOrEqual(1);
  });

  it('nobody decides their own request (engineer who is also a supervisor)', async () => {
    const own = (await api(dual).post('/material-requests').send({ workOrderId: wo.workOrderId, reason: 'Own request', lines: [{ itemId: ids.cable, quantity: 10 }] })).body;
    expect(own.permissions.canDecide).toBe(false);
    const r = await api(dual).post(`/material-requests/${own.id}/decision`).send({ decision: 'APPROVE' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/your own material request/);
  });

  it('clarification round trip, then approval with a reduced quantity (approval ≠ stock availability)', async () => {
    expect((await api(sup).post(`/material-requests/${mr.id}/decision`).send({ decision: 'REJECT' })).status).toBe(400);
    const clarify = await api(sup).post(`/material-requests/${mr.id}/decision`).send({ decision: 'CLARIFY', comment: 'Which rating exactly?' });
    expect(clarify.body.status).toBe('CLARIFICATION_REQUIRED');
    const edit = await api(eng).patch(`/material-requests/${mr.id}`).send({ clarificationReply: '63A, 12kV', lines: [{ itemId: ids.fuse, quantity: 8, specification: '63A 12kV HRC' }] });
    expect(edit.status).toBe(200);
    const resub = await api(eng).post(`/material-requests/${mr.id}/submit`);
    expect(resub.body.status).toBe('SUBMITTED');
    expect(resub.body.messages.map((m: any) => m.direction)).toEqual(['TO_REQUESTER', 'FROM_REQUESTER']);
    mr = resub.body;
    const lineId = mr.lines[0].lineId;
    const over = await api(sup).post(`/material-requests/${mr.id}/decision`).send({ decision: 'APPROVE', lines: [{ lineId, approvedQty: 9 }] });
    expect(over.status).toBe(400);
    const ok = await api(sup).post(`/material-requests/${mr.id}/decision`).send({ decision: 'APPROVE', comment: 'Approve 6 for now', lines: [{ lineId, approvedQty: 6 }] });
    expect(ok.body).toMatchObject({ status: 'APPROVED' });
    expect(ok.body.lines[0]).toMatchObject({ approvedQty: 6, outstandingQty: 6 });
    expect(await Notification.countDocuments({ type: 'materialRequest.readyToIssue', entityId: mr.id })).toBeGreaterThanOrEqual(1);
    mr = ok.body;
  });

  describe('MAT-03/04/06 store operations', () => {
    it('reserves within approved and available quantities', async () => {
      const lineId = mr.lines[0].lineId;
      expect((await api(store).post(`/material-requests/${mr.id}/reserve`).send({ lineId, warehouseId: ids.w1, quantity: 7 })).status).toBe(400); // > approved
      const r = await api(store).post(`/material-requests/${mr.id}/reserve`).send({ lineId, warehouseId: ids.w1, quantity: 4 });
      expect(r.status).toBe(200);
      expect(r.body.lines[0]).toMatchObject({ reservedQty: 4 });
      expect(await bal(ids.fuse, ids.w1)).toMatchObject({ onHand: 10, reserved: 4 });
    });

    it('BR-013: refuses to issue more than approved; partial issue consumes the reservation with evidence and serials', async () => {
      const lineId = mr.lines[0].lineId;
      const issueReq = (data: Record<string, unknown>, file = true) => {
        let r = request(getApp()).post(`/api/v1/material-requests/${mr.id}/issue`).set('Authorization', `Bearer ${store}`).field('data', JSON.stringify(data));
        if (file) r = r.attach('files', PNG, 'handover.png');
        return r;
      };
      const over = await issueReq({ lineId, warehouseId: ids.w1, quantity: 7, recipientName: 'meng' });
      expect(over.status).toBe(409);
      expect(over.body.error).toMatchObject({ code: 'EXCEEDS_APPROVED', details: { outstanding: 6 } });
      const badSerials = await issueReq({ lineId, warehouseId: ids.w1, quantity: 3, recipientName: 'meng', serialNumbers: ['S1'] });
      expect(badSerials.status).toBe(400);
      const noRecipient = await issueReq({ lineId, warehouseId: ids.w1, quantity: 3 });
      expect(noRecipient.status).toBe(400);
      const ok = await issueReq({ lineId, warehouseId: ids.w1, quantity: 3, recipientName: 'meng (engineer)', batchNo: 'B-7', serialNumbers: ['S1', 'S2', 'S3'] });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('PARTIALLY_ISSUED');
      expect(ok.body.lines[0]).toMatchObject({ issuedQty: 3, reservedQty: 1, outstandingQty: 3 });
      expect(await bal(ids.fuse, ids.w1)).toMatchObject({ onHand: 7, reserved: 1 });
      const tx = ok.body.transactions.find((t: any) => t.type === 'ISSUE');
      expect(tx).toMatchObject({ quantity: 3, batchNo: 'B-7', serialNumbers: ['S1', 'S2', 'S3'], recipientName: 'meng (engineer)' });
      expect(tx.evidence).toHaveLength(1);
      // Evidence is downloadable by people who can see the request.
      expect((await api(eng).get(`/files/${tx.evidence[0].id}/url`)).status).toBe(200);
      expect((await api(engB).get(`/files/${tx.evidence[0].id}/url`)).status).toBe(404);
      expect(await Notification.countDocuments({ type: 'materialRequest.issued', entityId: mr.id })).toBe(1);
    });

    it('insufficient stock is refused; backorder recorded; revised approval allows issuing more', async () => {
      const lineId = mr.lines[0].lineId;
      // W2 has 3 fuses; outstanding is 3 → issuing 3 from W2 is fine, but first try 3 when only 2 available after a reservation elsewhere.
      const bo = await api(store).post(`/material-requests/${mr.id}/backorder`).send({ lineId, quantity: 3, expectedAt: '2026-12-01T00:00:00Z', note: 'Supplier lead time' });
      expect(bo.body.lines[0].backorderQty).toBe(3);
      // Engineer cannot revise approval; supervisor revises to 8 with a reason.
      expect((await api(eng).post(`/material-requests/${mr.id}/revise-approval`).send({ lineId, approvedQty: 8, reason: 'More needed' })).status).toBe(403);
      expect((await api(sup).post(`/material-requests/${mr.id}/revise-approval`).send({ lineId, approvedQty: 2, reason: 'Too low' })).status).toBe(400); // below issued+reserved
      const rev = await api(sup).post(`/material-requests/${mr.id}/revise-approval`).send({ lineId, approvedQty: 8, reason: 'Second feeder also affected' });
      expect(rev.body.lines[0]).toMatchObject({ approvedQty: 8, outstandingQty: 5 });
      expect(rev.body.decisions.at(-1)).toMatchObject({ decision: 'REVISE', comment: 'Second feeder also affected' });
      const short = await request(getApp())
        .post(`/api/v1/material-requests/${mr.id}/issue`)
        .set('Authorization', `Bearer ${store}`)
        .field('data', JSON.stringify({ lineId, warehouseId: ids.w2, quantity: 5, recipientName: 'meng' }));
      expect(short.status).toBe(409);
      expect(short.body.error.code).toBe('INSUFFICIENT_STOCK'); // W2 only has 3
      const fromW2 = await request(getApp())
        .post(`/api/v1/material-requests/${mr.id}/issue`)
        .set('Authorization', `Bearer ${store}`)
        .field('data', JSON.stringify({ lineId, warehouseId: ids.w2, quantity: 3, recipientName: 'meng' }));
      expect(fromW2.body.lines[0]).toMatchObject({ issuedQty: 6, backorderQty: 0 });
      const rest = await request(getApp())
        .post(`/api/v1/material-requests/${mr.id}/issue`)
        .set('Authorization', `Bearer ${store}`)
        .field('data', JSON.stringify({ lineId, warehouseId: ids.w1, quantity: 2, recipientName: 'meng' }));
      expect(rest.body.status).toBe('ISSUED');
      expect(await bal(ids.fuse, ids.w1)).toMatchObject({ onHand: 5, reserved: 0 }); // reservation of 1 consumed + 1 more
      expect(await bal(ids.fuse, ids.w2)).toMatchObject({ onHand: 0, reserved: 0 });
    });

    it('returns: good stock goes back, damaged is recorded but not restocked; cannot over-return', async () => {
      const lineId = mr.lines[0].lineId;
      expect((await api(store).post(`/material-requests/${mr.id}/return`).send({ lineId, warehouseId: ids.w1, goodQty: 9, reason: 'Too many' })).status).toBe(400);
      const r = await api(store).post(`/material-requests/${mr.id}/return`).send({ lineId, warehouseId: ids.w1, goodQty: 2, damagedQty: 1, reason: 'Unused 2, one cracked' });
      expect(r.status).toBe(200);
      expect(r.body.lines[0]).toMatchObject({ returnedQty: 2, damagedQty: 1 });
      expect(r.body.transactions.map((t: any) => t.type)).toEqual(expect.arrayContaining(['RETURN', 'DAMAGE']));
      expect(await bal(ids.fuse, ids.w1)).toMatchObject({ onHand: 7 });
    });

    it('closes the handled request; ledger and balances reconcile', async () => {
      const close = await api(sup).post(`/material-requests/${mr.id}/close`).send({});
      expect(close.body.status).toBe('CLOSED');
      const rec = await api(store).get('/inventory/reconcile');
      expect(rec.body).toMatchObject({ consistent: true, drift: [] });
      expect(rec.body.checked).toBeGreaterThanOrEqual(3);
    });
  });
});

describe('concurrency and closure rules', () => {
  it('parallel issues can never overdraw stock', async () => {
    await api(store).post('/inventory/receipts').send({ warehouseId: ids.w2, lines: [{ itemId: ids.cable, quantity: 100 }] });
    const make = async () => {
      const r = (await api(eng).post('/material-requests').send({ workOrderId: wo.workOrderId, reason: 'Cable run', lines: [{ itemId: ids.cable, quantity: 80 }] })).body;
      return (await api(sup).post(`/material-requests/${r.id}/decision`).send({ decision: 'APPROVE' })).body;
    };
    const [a, b] = [await make(), await make()];
    const issueOf = (m: any) =>
      request(getApp())
        .post(`/api/v1/material-requests/${m.id}/issue`)
        .set('Authorization', `Bearer ${store}`)
        .field('data', JSON.stringify({ lineId: m.lines[0].lineId, warehouseId: ids.w2, quantity: 80, recipientName: 'meng' }));
    const results = await Promise.all([issueOf(a), issueOf(b)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await bal(ids.cable, ids.w2)).toMatchObject({ onHand: 20 });
    expect((await api(store).get('/inventory/reconcile')).body.consistent).toBe(true);
  });

  it('close is blocked while stock is still reserved', async () => {
    const r = (await api(eng).post('/material-requests').send({ workOrderId: wo.workOrderId, reason: 'Spare fuse', lines: [{ itemId: ids.fuse, quantity: 2 }] })).body;
    const ap = (await api(sup).post(`/material-requests/${r.id}/decision`).send({ decision: 'APPROVE' })).body;
    const lineId = ap.lines[0].lineId;
    await api(store).post(`/material-requests/${r.id}/reserve`).send({ lineId, warehouseId: ids.w1, quantity: 2 });
    await request(getApp()).post(`/api/v1/material-requests/${r.id}/issue`).set('Authorization', `Bearer ${store}`).field('data', JSON.stringify({ lineId, warehouseId: ids.w1, quantity: 1, recipientName: 'meng' }));
    const blocked = await api(sup).post(`/material-requests/${r.id}/close`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/reserved stock/);
    await api(store).post(`/material-requests/${r.id}/unreserve`).send({ lineId, warehouseId: ids.w1, quantity: 1, reason: 'Not needed' });
    expect((await api(sup).post(`/material-requests/${r.id}/close`).send({})).body.status).toBe('CLOSED');
  });

  it('BR-016: a complaint cannot be resolved while material requests are open', async () => {
    const open = (await api(eng).post('/material-requests').send({ workOrderId: wo.workOrderId, reason: 'Pending', lines: [{ itemId: ids.fuse, quantity: 1 }] })).body;
    const ctx = { auth: { userId: new mongoose.Types.ObjectId().toString(), sessionId: 'x', name: 'Sup', email: 's@s', roles: [], permissions: new Set(['complaint.resolve']) as never, scope: { global: true, organizationIds: [], regionIds: [], siteIds: [] } } };
    await expect(transition({ entity: 'complaint', record: { _id: new mongoose.Types.ObjectId(wo.complaintId), status: 'APPROVED' } as never, action: 'resolve', ctx })).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(`Material requests still open: .*${open.requestNo}`)),
    });
  });

  it('other regions cannot see the requests', async () => {
    const list = await api(engB).get('/material-requests?limit=100');
    expect(list.body.data).toHaveLength(0);
  });
});

describe('store queue ordering and catalogue options', () => {
  it('store queue sorts by severity (critical first), then oldest; summaries show outstanding lines', async () => {
    const mk = async (urgency: string) => {
      const r = (await api(eng).post('/material-requests').send({ workOrderId: wo.workOrderId, urgency, reason: `Urgency ${urgency}`, lines: [{ itemId: ids.cable, quantity: 1 }] })).body;
      return (await api(sup).post(`/material-requests/${r.id}/decision`).send({ decision: 'APPROVE' })).body;
    };
    const low = await mk('LOW');
    const crit = await mk('CRITICAL');
    const high = await mk('HIGH');
    const q = (await api(store).get('/material-requests?store=true&limit=100')).body.data;
    const order = q.map((x: any) => x.id).filter((id: string) => [low.id, crit.id, high.id].includes(id));
    expect(order).toEqual([crit.id, high.id, low.id]);
    expect(q.find((x: any) => x.id === crit.id).outstandingLines).toBe(1);
    const detail = (await api(store).get(`/material-requests/${crit.id}`)).body;
    expect(detail.permissions).toMatchObject({ canIssue: true, canReturn: false });
  });

  it('catalogue options include the unit', async () => {
    const opts = (await api(eng).get('/masters/inventoryItems/options')).body;
    expect(opts.find((o: any) => o.code === 'FUSE63')).toMatchObject({ unit: 'EA' });
  });
});
