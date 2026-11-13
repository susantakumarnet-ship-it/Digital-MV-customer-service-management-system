import { expect, request as pwRequest, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Phase 6 journey: a reviewer approves one submitted report and returns another with item feedback;
 * the engineer sees the feedback on the new revision, corrects it and resubmits.
 * Setup goes through the API (two Central-region demo complaints, engineer1 = Eli).
 */
const DEMO_PASSWORD = 'E2e-Demo-Passw0rd';
const API = 'http://localhost:4710/api/v1';
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a9f6e0f00000000049454e44ae426082',
  'hex',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const reports: Record<string, { reportId: string; workOrderId: string; workOrderNo: string }> = {};

async function apiAs(identifier: string) {
  const ctx = await pwRequest.newContext({ baseURL: API });
  const r = await ctx.post(`${API}/auth/login`, { data: { identifier, password: DEMO_PASSWORD } });
  expect(r.ok()).toBeTruthy();
  const token = (await r.json()).accessToken as string;
  return { ctx, h: { Authorization: `Bearer ${token}` } };
}

async function ok(res: Awaited<ReturnType<APIRequestContext['get']>>) {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

/** Classify → work order for Eli → accept → visit → full time sequence → answered RMU checklist → submitted. */
async function submittedReportFor(search: string) {
  const sup = await apiAs('supervisor@example.com');
  const eng = await apiAs('engineer1@example.com');
  const complaint = (await ok(await sup.ctx.get(`${API}/complaints?q=${encodeURIComponent(search)}`, { headers: sup.h }))).data[0];
  const pr = (await ok(await sup.ctx.get(`${API}/masters/priorities/options`, { headers: sup.h }))).find((p: any) => p.code === 'P2');
  const rt = (await ok(await sup.ctx.get(`${API}/masters/requestTypes/options`, { headers: sup.h }))).find((x: any) => x.code === 'PM');
  await ok(await sup.ctx.put(`${API}/complaints/${complaint.id}/classification`, { headers: sup.h, data: { requestTypeId: rt.id, priorityId: pr.id } }));
  const eli = (await ok(await sup.ctx.get(`${API}/work-orders/workload`, { headers: sup.h }))).find((e: any) => e.email === 'engineer1@example.com');
  const wo = await ok(await sup.ctx.post(`${API}/complaints/${complaint.id}/work-orders`, { headers: sup.h, data: { title: `Service: ${search}`, description: 'Inspect and service the unit.', assigneeIds: [eli.id] } }));
  await ok(await eng.ctx.post(`${API}/work-orders/${wo.id}/transitions`, { headers: eng.h, data: { action: 'accept' } }));
  const visit = await ok(await eng.ctx.post(`${API}/work-orders/${wo.id}/visits`, { headers: eng.h, data: { purpose: 'Scheduled service visit' } }));
  for (const e of ['START_TRAVEL', 'ARRIVE_SITE', 'START_WORK', 'END_WORK', 'START_RETURN', 'ARRIVE_BASE']) {
    await ok(await eng.ctx.post(`${API}/visits/${visit.id}/time-events`, { headers: eng.h, data: { eventType: e } }));
  }
  const report = await ok(await eng.ctx.post(`${API}/visits/${visit.id}/inspection-reports`, { headers: eng.h, data: {} }));
  const upload = (itemKey: string, name: string, mimeType: string, buffer: Buffer) =>
    eng.ctx.post(`${API}/inspection-reports/${report.id}/attachments`, { headers: eng.h, multipart: { data: JSON.stringify({ itemKey }), files: { name, mimeType, buffer } } });
  for (const item of report.items) {
    if (item.evidence === 'PHOTO') await ok(await upload(item.key, `${item.key}.png`, 'image/png', PNG));
    if (item.evidence === 'DOCUMENT' || item.evidence === 'ANY') await ok(await upload(item.key, `${item.key}.pdf`, 'application/pdf', PDF));
  }
  await ok(await eng.ctx.put(`${API}/inspection-reports/${report.id}`, { headers: eng.h, data: { results: report.items.map((i: any) => ({ itemKey: i.key, result: 'PASS' })), findings: 'All checks satisfactory.' } }));
  await ok(await eng.ctx.post(`${API}/inspection-reports/${report.id}/submit`, { headers: eng.h }));
  await sup.ctx.dispose();
  await eng.ctx.dispose();
  return { reportId: report.id as string, workOrderId: wo.id as string, workOrderNo: wo.workOrderNo as string };
}

async function signIn(page: Page, identifier: string) {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(identifier);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 6 review and approval', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    reports.approve = await submittedReportFor('preventive maintenance');
    reports.return = await submittedReportFor('oil seepage');
  });

  test('reviewer sees both reports in the queue and approves one', async ({ page }) => {
    await signIn(page, 'reviewer@example.com');
    await page.goto('/reviews');
    await expect(page.getByText(reports.approve.workOrderNo).first()).toBeVisible();
    await expect(page.getByText(reports.return.workOrderNo).first()).toBeVisible();

    await page.goto(`/reviews/${reports.approve.reportId}`);
    await expect(page.getByText('Time log').first()).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const done = page.waitForResponse((r) => r.url().includes('/review-actions') && r.request().method() === 'POST');
    await page.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
    expect((await done).status()).toBe(200);
    await expect(page.getByText('Approved').first()).toBeVisible();

    await page.goto(`/work-orders/${reports.approve.workOrderId}`);
    await expect(page.getByText('Approved').first()).toBeVisible();
  });

  test('reviewer returns the other report with item feedback', async ({ page }) => {
    await signIn(page, 'reviewer@example.com');
    await page.goto(`/reviews/${reports.return.reportId}`);
    await page.getByRole('button', { name: 'Add feedback' }).first().click();
    await page.getByLabel('Feedback for the engineer').first().fill('Please attach a close-up photo of the gauge.');
    await page.getByRole('button', { name: 'Return for correction' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/What must be corrected/).fill('Evidence incomplete — see item feedback.');
    await expect(dialog.getByText('Please attach a close-up photo of the gauge.').or(dialog.getByLabel(/Feedback for/)).first()).toBeVisible();
    const done = page.waitForResponse((r) => r.url().includes('/review-actions') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Return for correction' }).click();
    const res = await done;
    expect(res.status()).toBe(200);
    reports.revision2 = { ...reports.return, reportId: (await res.json()).reportId };
    expect(reports.revision2.reportId).not.toBe(reports.return.reportId);
  });

  test('engineer sees the feedback on the new revision, corrects it and resubmits', async ({ page }) => {
    await signIn(page, 'engineer1@example.com');
    await page.goto(`/inspection-reports/${reports.revision2.reportId}`);
    await expect(page.getByText(/Returned for correction by/).first()).toBeVisible();
    await expect(page.getByText('Evidence incomplete — see item feedback.').first()).toBeVisible();
    await expect(page.getByText('Please attach a close-up photo of the gauge.').first()).toBeVisible();

    await page.getByRole('button', { name: /Preview & submit/ }).first().click();
    await expect(page.getByTestId('submit-report')).toBeEnabled();
    await page.getByTestId('submit-report').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Submitted').first()).toBeVisible();
  });

  test('the resubmitted revision is back in the queue and can be compared with revision 1', async ({ page }) => {
    await signIn(page, 'reviewer@example.com');
    await page.goto('/reviews');
    await expect(page.getByText(/r2/).first()).toBeVisible();
    await page.goto(`/inspection-reports/${reports.revision2.reportId}/compare?with=${reports.return.reportId}`);
    await expect(page.getByText(/Show unchanged/i).first()).toBeVisible();
  });

  test('the engineer who did the work cannot review it', async ({ page }) => {
    await signIn(page, 'engineer1@example.com');
    await page.goto(`/reviews/${reports.revision2.reportId}`);
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  });
});
