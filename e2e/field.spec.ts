import { expect, request as pwRequest, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Phase 5 field journey on the production build:
 * engineer accepts → plans a visit → records travel/work time → inspects (checklist + photo + document)
 * → submits (report locked) → returns to base (visit completed) → supervisor sees the full time log.
 * Setup (classify + assign) goes through the API to keep the journey focused on field screens.
 * Demo data: "Southport Hospital Campus" (South region) — engineer2 (Erin) covers South.
 */
const DEMO_PASSWORD = 'E2e-Demo-Passw0rd';
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a9f6e0f00000000049454e44ae426082',
  'hex',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

let workOrderId = '';
let visitUrl = '';

async function apiAs(identifier: string): Promise<{ ctx: APIRequestContext; token: string }> {
  const ctx = await pwRequest.newContext({ baseURL: 'http://localhost:4610' });
  const r = await ctx.post('/api/v1/auth/login', { data: { identifier, password: DEMO_PASSWORD } });
  expect(r.ok()).toBeTruthy();
  return { ctx, token: (await r.json()).accessToken };
}

async function signIn(page: Page, identifier: string) {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(identifier);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Taps the big "next event" button; END_WORK / ARRIVE_BASE need confirmation. */
async function tap(page: Page, label: string, confirm = false) {
  const done = page.waitForResponse((r) => r.url().includes('/time-events') && r.request().method() === 'POST');
  await page.getByRole('button', { name: label, exact: true }).first().click();
  if (confirm) await page.getByRole('alertdialog').getByRole('button', { name: label }).click();
  expect((await done).status()).toBe(200);
}

async function answer(page: Page, description: RegExp, result: string) {
  await page.getByRole('radiogroup', { name: description }).getByRole('radio', { name: result, exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 5 field workflow', () => {
  test.beforeAll(async () => {
    const { ctx, token } = await apiAs('supervisor@example.com');
    const h = { Authorization: `Bearer ${token}` };
    const list = await (await ctx.get('/api/v1/complaints?q=Block%20C', { headers: h })).json();
    const complaint = list.data[0];
    const pr = (await (await ctx.get('/api/v1/masters/priorities/options', { headers: h })).json()).find((p: any) => p.code === 'P1');
    const rt = (await (await ctx.get('/api/v1/masters/requestTypes/options', { headers: h })).json()).find((x: any) => x.code === 'BRK');
    expect((await ctx.put(`/api/v1/complaints/${complaint.id}/classification`, { headers: h, data: { requestTypeId: rt.id, priorityId: pr.id } })).ok()).toBeTruthy();
    const erin = (await (await ctx.get('/api/v1/work-orders/workload', { headers: h })).json()).find((e: any) => e.email === 'engineer2@example.com');
    const wo = await ctx.post(`/api/v1/complaints/${complaint.id}/work-orders`, {
      headers: h,
      data: { title: 'Restore supply to Block C', description: 'Investigate earth fault alarm and restore supply.', assigneeIds: [erin.id] },
    });
    expect(wo.status()).toBe(201);
    workOrderId = (await wo.json()).id;
    await ctx.dispose();
  });

  test('engineer accepts the job and plans a visit', async ({ page }) => {
    await signIn(page, 'engineer2@example.com');
    await page.goto(`/work-orders/${workOrderId}`);
    await page.getByRole('button', { name: 'Accept work' }).click();
    await expect(page.getByText('Accepted').first()).toBeVisible();
    await page.getByRole('button', { name: 'Plan a visit' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create visit' }).click();
    await expect(page).toHaveURL(/\/visits\/[a-f0-9]{24}$/);
    visitUrl = page.url();
    await expect(page.getByRole('button', { name: 'Start Travel from Base', exact: true })).toBeVisible();
  });

  test('engineer records travel and work time (server time), then completes the inspection and submits', async ({ page }) => {
    await signIn(page, 'engineer2@example.com');
    await page.goto(visitUrl);
    await tap(page, 'Start Travel from Base');
    await tap(page, 'Arrive at Site');
    await tap(page, 'Start Work at Site');
    await tap(page, 'End Work at Site', true);
    await expect(page.getByRole('button', { name: 'Start Return Travel', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Start inspection' }).click();
    await expect(page).toHaveURL(/\/inspection-reports\/[a-f0-9]{24}$/);
    const reportUrl = page.url();

    await answer(page, /safety briefing/i, 'Pass');
    await answer(page, /Enclosure, doors and locks/i, 'Pass');
    await page.getByLabel('Take photo for VIS').setInputFiles({ name: 'enclosure.png', mimeType: 'image/png', buffer: PNG });
    // The thumbnail swaps text for an <img alt> once loaded, so assert on the stable remove control.
    await expect(page.getByRole('button', { name: 'Remove enclosure.png' })).toBeVisible();
    await answer(page, /SF6 gas pressure/i, 'Not applicable');
    await page.getByRole('textbox', { name: /reason/i }).first().fill('Air-insulated unit, no SF6');
    await answer(page, /Switch operation/i, 'Pass');
    await answer(page, /Insulation resistance/i, 'Pass');
    await page.getByLabel('Attach file for IR').setInputFiles({ name: 'ir-results.pdf', mimeType: 'application/pdf', buffer: PDF });
    await expect(page.getByRole('button', { name: 'Remove ir-results.pdf' })).toBeVisible();
    await expect(page.getByText(/Saved/).first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /Preview & submit/ }).first().click();
    await expect(page.getByTestId('submit-report')).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId('submit-report').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText(/read-only/i).first()).toBeVisible();
    await expect(page.getByText('Submitted').first()).toBeVisible();

    // Locked: result controls are disabled after submission.
    await page.goto(reportUrl);
    await expect(page.getByRole('radiogroup', { name: /safety briefing/i }).getByRole('radio', { name: 'Fail', exact: true })).toBeDisabled();
  });

  test('engineer returns to base and the visit completes', async ({ page }) => {
    await signIn(page, 'engineer2@example.com');
    await page.goto(visitUrl);
    await tap(page, 'Start Return Travel');
    await tap(page, 'Arrive at Base', true);
    await expect(page.getByText('Completed').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Return Travel', exact: true })).toHaveCount(0);
  });

  test('supervisor sees the six-step time log and durations; work order is Submitted', async ({ page }) => {
    await signIn(page, 'supervisor@example.com');
    await page.goto(visitUrl);
    for (const label of ['Start Travel from Base', 'Arrive at Site', 'Start Work at Site', 'End Work at Site', 'Start Return Travel', 'Arrive at Base']) {
      await expect(page.getByText(label).first()).toBeVisible();
    }
    await expect(page.getByText(/Total elapsed/i).first()).toBeVisible();
    await page.goto(`/work-orders/${workOrderId}`);
    await expect(page.getByText('Submitted').first()).toBeVisible();
  });
});

test('@mobile field visit screen fits a phone and keeps the main action reachable', async ({ page }) => {
  await signIn(page, 'engineer1@example.com');
  await page.goto('/visits');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
