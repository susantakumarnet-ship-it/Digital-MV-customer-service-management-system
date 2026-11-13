import { expect, request as pwRequest, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Phase 8 journey on a new Hillcrest (North, Acme) complaint created for this spec: an approved report
 * with a failed item → engineer raises an NCR in the UI → owner works it (API) → a reviewer verifies it
 * in the UI → supervisor requests acceptance → the Acme customer accepts in the portal → supervisor closes.
 */
const DEMO_PASSWORD = 'E2e-Demo-Passw0rd';
const API = 'http://localhost:4710/api/v1';
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a9f6e0f00000000049454e44ae426082',
  'hex',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const s: Record<string, string> = {};

async function apiAs(identifier: string) {
  const ctx = await pwRequest.newContext({ baseURL: API });
  const r = await ctx.post(`${API}/auth/login`, { data: { identifier, password: DEMO_PASSWORD } });
  expect(r.ok()).toBeTruthy();
  return { ctx, h: { Authorization: `Bearer ${(await r.json()).accessToken as string}` } };
}

async function ok(res: Awaited<ReturnType<APIRequestContext['get']>>) {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

async function signIn(page: Page, identifier: string) {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(identifier);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 8 NCR, customer acceptance and closure', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const sup = await apiAs('supervisor@example.com');
    const eng = await apiAs('engineer1@example.com');
    const rev = await apiAs('reviewer@example.com');
    // Own complaint (Hillcrest, Acme) so other specs' demo complaints stay untouched.
    const site = (await ok(await sup.ctx.get(`${API}/masters/sites/options`, { headers: sup.h }))).find((x: any) => x.code === 'SITE-HC-01');
    const asset = (await ok(await sup.ctx.get(`${API}/masters/assets/options?parentField=siteId&parentId=${site.id}`, { headers: sup.h })))[0];
    const rtIntake = (await ok(await sup.ctx.get(`${API}/masters/requestTypes/options`, { headers: sup.h }))).find((x: any) => x.code === 'WAR');
    const complaint = await ok(
      await sup.ctx.post(`${API}/complaints`, {
        headers: { ...sup.h, 'Idempotency-Key': `e2e-p8-${Date.now()}` },
        multipart: {
          data: JSON.stringify({
            source: 'PHONE',
            customerName: 'Hillcrest Water Works',
            organizationName: 'Hillcrest Water Works',
            contactPerson: 'Duty Engineer',
            mobile: '+44 7700 900111',
            email: 'hillcrest-duty@example.com',
            regionId: site.regionId,
            cityId: site.cityId,
            siteId: site.id,
            assetId: asset?.id,
            requestTypeId: rtIntake.id,
            description: 'Earthing switch interlock does not engage on the RMU panel.',
          }),
        },
      }),
    );
    const pr = (await ok(await sup.ctx.get(`${API}/masters/priorities/options`, { headers: sup.h }))).find((p: any) => p.code === 'P2');
    const rt = (await ok(await sup.ctx.get(`${API}/masters/requestTypes/options`, { headers: sup.h }))).find((x: any) => x.code === 'WAR');
    await ok(await sup.ctx.put(`${API}/complaints/${complaint.id}/classification`, { headers: sup.h, data: { requestTypeId: rt.id, priorityId: pr.id } }));
    const eli = (await ok(await sup.ctx.get(`${API}/work-orders/workload`, { headers: sup.h }))).find((e: any) => e.email === 'engineer1@example.com');
    const wo = await ok(await sup.ctx.post(`${API}/complaints/${complaint.id}/work-orders`, { headers: sup.h, data: { title: 'Earthing switch interlock repair', description: 'Inspect and repair the interlock.', assigneeIds: [eli.id] } }));
    await ok(await eng.ctx.post(`${API}/work-orders/${wo.id}/transitions`, { headers: eng.h, data: { action: 'accept' } }));
    const visit = await ok(await eng.ctx.post(`${API}/work-orders/${wo.id}/visits`, { headers: eng.h, data: { purpose: 'Repair earthing switch interlock' } }));
    for (const e of ['START_TRAVEL', 'ARRIVE_SITE', 'START_WORK', 'END_WORK', 'START_RETURN', 'ARRIVE_BASE']) {
      await ok(await eng.ctx.post(`${API}/visits/${visit.id}/time-events`, { headers: eng.h, data: { eventType: e } }));
    }
    const report = await ok(await eng.ctx.post(`${API}/visits/${visit.id}/inspection-reports`, { headers: eng.h, data: {} }));
    const upload = (itemKey: string, name: string, mimeType: string, buffer: Buffer) =>
      eng.ctx.post(`${API}/inspection-reports/${report.id}/attachments`, { headers: eng.h, multipart: { data: JSON.stringify({ itemKey }), files: { name, mimeType, buffer } } });
    for (const item of report.items) {
      if (item.evidence === 'PHOTO' || item.evidenceOnFail) await ok(await upload(item.key, `${item.key}.png`, 'image/png', PNG));
      if (item.evidence === 'DOCUMENT' || item.evidence === 'ANY') await ok(await upload(item.key, `${item.key}.pdf`, 'application/pdf', PDF));
    }
    const results = report.items.map((i: any, idx: number) => (idx === 0 ? { itemKey: i.key, result: 'FAIL', remarks: 'Gauge reads below minimum' } : { itemKey: i.key, result: 'PASS' }));
    await ok(await eng.ctx.put(`${API}/inspection-reports/${report.id}`, { headers: eng.h, data: { results, findings: 'Gas pressure low; topped up.' } }));
    await ok(await eng.ctx.post(`${API}/inspection-reports/${report.id}/submit`, { headers: eng.h }));
    for (const action of ['startReview', 'approve']) await ok(await rev.ctx.post(`${API}/inspection-reports/${report.id}/review-actions`, { headers: rev.h, data: { action } }));
    Object.assign(s, { complaintId: complaint.id, referenceNo: complaint.referenceNo, workOrderId: wo.id, engId: eli.id });
    for (const c of [sup, eng, rev]) await c.ctx.dispose();
  });

  test('engineer raises an NCR from the work order', async ({ page }) => {
    await signIn(page, 'engineer1@example.com');
    await page.goto(`/work-orders/${s.workOrderId}`);
    await page.getByRole('button', { name: 'Raise NCR' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Category').selectOption('Material/Component defect');
    await dialog.getByLabel('Severity').selectOption('Major');
    await dialog.getByLabel('Title').fill('SF6 density monitor faulty');
    await dialog.getByLabel('Description').fill('Density monitor gives false low-pressure alarms after top-up.');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/ncrs') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Raise NCR' }).click();
    const res = await created;
    expect(res.status()).toBe(201);
    const n = await res.json();
    s.ncrId = n.id;
    s.ncrNo = n.ncrNo;
    await expect(page.getByText(n.ncrNo).first()).toBeVisible();

    // Owner works the NCR (API): assign → actions → submit; reviewer adds verification evidence.
    const sup = await apiAs('supervisor@example.com');
    const eng = await apiAs('engineer1@example.com');
    const rev = await apiAs('reviewer@example.com');
    await ok(await sup.ctx.post(`${API}/ncrs/${n.id}/assign`, { headers: sup.h, data: { ownerId: s.engId } }));
    await ok(await eng.ctx.put(`${API}/ncrs/${n.id}/actions`, { headers: eng.h, data: { containmentAction: 'Alarm acknowledged, gas checked manually', rootCause: 'Faulty density monitor', correctiveAction: 'Replaced density monitor', disposition: 'REPLACE' } }));
    await ok(await eng.ctx.post(`${API}/ncrs/${n.id}/transition`, { headers: eng.h, data: { action: 'submitForVerification' } }));
    await ok(await rev.ctx.post(`${API}/ncrs/${n.id}/attachments`, { headers: rev.h, multipart: { data: JSON.stringify({ context: 'verification' }), files: { name: 'monitor.png', mimeType: 'image/png', buffer: PNG } } }));
    for (const c of [sup, eng, rev]) await c.ctx.dispose();
  });

  test('a reviewer verifies the corrective action', async ({ page }) => {
    await signIn(page, 'reviewer@example.com');
    await page.goto(`/ncrs/${s.ncrId}`);
    await expect(page.getByText('Replaced density monitor').first()).toBeVisible();
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    const done = page.waitForResponse((r) => r.url().includes(`/ncrs/${s.ncrId}/transition`) && r.request().method() === 'POST');
    await page.locator('[role="dialog"], [role="alertdialog"]').getByRole('button', { name: 'Verify', exact: true }).click();
    expect((await done).status()).toBe(200);
    await expect(page.getByText('Verified').first()).toBeVisible();
  });

  test('supervisor resolves and requests customer acceptance', async ({ page }) => {
    const sup = await apiAs('supervisor@example.com');
    await ok(await sup.ctx.post(`${API}/complaints/${s.complaintId}/transitions`, { headers: sup.h, data: { action: 'resolve' } }));
    await sup.ctx.dispose();
    await signIn(page, 'supervisor@example.com');
    await page.goto(`/complaints/${s.complaintId}`);
    await expect(page.getByText('Resolution & acceptance').first()).toBeVisible();
    await page.getByRole('button', { name: 'Request acceptance' }).click();
    const sent = page.waitForResponse((r) => r.url().includes('/request-acceptance'));
    await page.getByRole('dialog').getByRole('button', { name: 'Send request' }).click();
    expect((await sent).status()).toBe(200);
    await expect(page.getByText('Customer Acceptance Pending').first()).toBeVisible();
    await expect(page.getByText('Awaiting the customer').first()).toBeVisible();
  });

  test('the customer accepts the service in the portal', async ({ page }) => {
    await signIn(page, 'customer@example.com');
    await page.goto(`/complaints/${s.complaintId}`);
    await expect(page.getByText('Please confirm the service').first()).toBeVisible();
    await page.getByText('Accept the service').click();
    await page.getByLabel('5 stars').check({ force: true });
    const decided = page.waitForResponse((r) => r.url().endsWith(`/complaints/${s.complaintId}/acceptance`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Submit decision' }).click();
    expect((await decided).status()).toBe(200);
    await expect(page.getByText('Customer Accepted').first()).toBeVisible();
  });

  test('supervisor closes the complaint once every condition is met', async ({ page }) => {
    await signIn(page, 'supervisor@example.com');
    await page.goto(`/complaints/${s.complaintId}`);
    const close = page.getByRole('button', { name: 'Close complaint' });
    await expect(close).toBeEnabled();
    await close.click();
    const done = page.waitForResponse((r) => r.url().includes(`/complaints/${s.complaintId}/transitions`) && r.request().method() === 'POST');
    await page.locator('[role="dialog"], [role="alertdialog"]').getByRole('button', { name: 'Close complaint' }).click();
    expect((await done).status()).toBe(200);
    await expect(page.getByText('Closed').first()).toBeVisible();
  });

  test('an invalid acceptance link shows a clear message', async ({ page }) => {
    await page.goto(`/acceptance/${'x'.repeat(43)}`);
    await expect(page.getByText('This link is not valid')).toBeVisible();
  });
});
