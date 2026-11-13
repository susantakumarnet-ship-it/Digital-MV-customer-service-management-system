import { expect, request as pwRequest, test, type Page } from '@playwright/test';

/**
 * Phase 7 journey: engineer requests material from the work order → supervisor approves →
 * storekeeper issues from a warehouse with handover evidence → ledger records it; integrity check passes.
 * Setup (classify + work order + accept) goes through the API. Demo: Northfield (North) — engineer1.
 */
const DEMO_PASSWORD = 'E2e-Demo-Passw0rd';
const API = 'http://localhost:4710/api/v1';
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a9f6e0f00000000049454e44ae426082',
  'hex',
);
let workOrderId = '';
let requestUrl = '';

async function apiAs(identifier: string) {
  const ctx = await pwRequest.newContext({ baseURL: API });
  const r = await ctx.post(`${API}/auth/login`, { data: { identifier, password: DEMO_PASSWORD } });
  expect(r.ok()).toBeTruthy();
  return { ctx, h: { Authorization: `Bearer ${(await r.json()).accessToken}` } };
}

async function signIn(page: Page, identifier: string) {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(identifier);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function pick(page: Page, select: ReturnType<Page['getByRole']>, text: string) {
  const option = select.locator('option', { hasText: text }).first();
  await expect(option).toBeAttached();
  await select.selectOption((await option.getAttribute('value'))!);
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 7 material request → approval → issue', () => {
  test.beforeAll(async () => {
    const sup = await apiAs('supervisor@example.com');
    const eng = await apiAs('engineer1@example.com');
    const complaint = (await (await sup.ctx.get(`${API}/complaints?q=trips%20repeatedly`, { headers: sup.h })).json()).data[0];
    const pr = (await (await sup.ctx.get(`${API}/masters/priorities/options`, { headers: sup.h })).json()).find((p: any) => p.code === 'P2');
    const rt = (await (await sup.ctx.get(`${API}/masters/requestTypes/options`, { headers: sup.h })).json()).find((x: any) => x.code === 'BRK');
    expect((await sup.ctx.put(`${API}/complaints/${complaint.id}/classification`, { headers: sup.h, data: { requestTypeId: rt.id, priorityId: pr.id } })).ok()).toBeTruthy();
    const eli = (await (await sup.ctx.get(`${API}/work-orders/workload`, { headers: sup.h })).json()).find((e: any) => e.email === 'engineer1@example.com');
    const wo = await (await sup.ctx.post(`${API}/complaints/${complaint.id}/work-orders`, { headers: sup.h, data: { title: 'Replace fuses on feeder', description: 'Replace blown HRC fuses.', assigneeIds: [eli.id] } })).json();
    workOrderId = wo.id;
    expect((await eng.ctx.post(`${API}/work-orders/${wo.id}/transitions`, { headers: eng.h, data: { action: 'accept' } })).ok()).toBeTruthy();
    await sup.ctx.dispose();
    await eng.ctx.dispose();
  });

  test('engineer requests material from the work order', async ({ page }) => {
    await signIn(page, 'engineer1@example.com');
    await page.goto(`/work-orders/${workOrderId}`);
    await page.getByRole('button', { name: 'Request material' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Why is the material needed?').fill('Two fuses blown on feeder 2, need spares.');
    await pick(page, dialog.getByRole('combobox', { name: /Catalogue item/ }), 'MAT-FUSE-63');
    await dialog.getByRole('spinbutton', { name: /Quantity/ }).or(dialog.getByLabel(/^Quantity/)).first().fill('4');
    const created = page.waitForResponse((r) => r.url().endsWith('/material-requests') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Submit request' }).click();
    const res = await created;
    expect(res.status()).toBe(201);
    requestUrl = `/materials/${(await res.json()).id}`;
  });

  test('supervisor approves the request', async ({ page }) => {
    await signIn(page, 'supervisor@example.com');
    await page.goto(requestUrl);
    await expect(page.getByText('Submitted').first()).toBeVisible();
    await page.getByRole('radiogroup', { name: 'Decision' }).getByRole('radio', { name: 'Approve' }).click();
    const done = page.waitForResponse((r) => r.url().includes('/decision') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Approve request' }).click();
    expect((await done).status()).toBe(200);
    await expect(page.getByText('Approved').first()).toBeVisible();
  });

  test('storekeeper issues from the Central Store with handover evidence', async ({ page }) => {
    await signIn(page, 'storekeeper@example.com');
    await page.goto(requestUrl);
    await page.getByRole('button', { name: 'Issue', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await pick(page, dialog.getByRole('combobox', { name: /Warehouse/ }), 'Central Store');
    await dialog.getByLabel(/Received by/).fill('Eli Engineer');
    await dialog.locator('input[type="file"]').first().setInputFiles({ name: 'handover.png', mimeType: 'image/png', buffer: PNG });
    const done = page.waitForResponse((r) => r.url().includes('/issue') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Issue material' }).click();
    expect((await done).status()).toBe(200);
    await expect(page.getByText('Issued').first()).toBeVisible();
  });

  test('the ledger shows the issue and the integrity check passes', async ({ page }) => {
    await signIn(page, 'storekeeper@example.com');
    await page.goto('/inventory/ledger');
    // Scope to the ledger table (the type filter dropdown also contains the word).
    await expect(page.getByRole('table').getByText(/^Issued?$/).first()).toBeVisible();
    await page.goto('/inventory');
    await page.getByRole('button', { name: 'Run check' }).click();
    await expect(page.getByRole('status').filter({ hasText: /balances match the ledger/ })).toBeVisible();
  });
});
