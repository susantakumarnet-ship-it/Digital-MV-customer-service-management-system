import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4 journey: supervisor classifies a demo complaint, creates a work order with a planned
 * visit and assigns engineer1 → complaint becomes Assigned → engineer accepts from the dashboard →
 * the job appears on the supervisor's week board.
 * Demo data: "Hillcrest Water Works" (North region) — engineer1 covers North & Central.
 */
const DEMO_PASSWORD = 'E2e-Demo-Passw0rd';
let workOrderNo = '';
let workOrderUrl = '';

async function signIn(page: Page, identifier: string) {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(identifier);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function pick(page: Page, name: RegExp, text: string) {
  const select = page.getByRole('combobox', { name });
  const option = select.locator('option', { hasText: text }).first();
  await expect(option).toBeAttached();
  await select.selectOption((await option.getAttribute('value'))!);
}

function tomorrowAt9Local() {
  const d = new Date(Date.now() + 86400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`;
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 4 work-order lifecycle', () => {
  test('supervisor classifies a complaint, creates a work order and assigns an engineer', async ({ page }) => {
    await signIn(page, 'supervisor@example.com');
    await page.goto('/complaints');
    await page.getByLabel('Search complaints').fill('SF6 low-pressure');
    // Wait for the filtered row before opening it (the list filters after a short debounce).
    await page.getByRole('row', { name: /Hillcrest/ }).getByRole('link', { name: /^MV-\d{4}-\d{6}$/ }).first().click();

    await pick(page, /^Priority/, 'High');
    await page.getByRole('button', { name: 'Classify & start review' }).click();
    await expect(page.getByText('Under Review').first()).toBeVisible();

    await page.getByRole('button', { name: 'Create work order' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Title').fill('Investigate SF6 low-pressure alarm');
    await dialog.getByLabel('Planned visit start').fill(tomorrowAt9Local());
    await dialog.getByRole('checkbox', { name: /Eli Engineer/ }).click();
    await dialog.getByRole('button', { name: 'Create work order' }).click();

    await expect(page).toHaveURL(/\/work-orders\/[a-f0-9]{24}$/);
    workOrderUrl = page.url();
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(/WO-\d{4}-\d{6}/);
    workOrderNo = (await heading.textContent())!.match(/WO-\d{4}-\d{6}/)![0];
    await expect(page.getByText('Assigned').first()).toBeVisible();
    await expect(page.getByText('Eli Engineer').first()).toBeVisible();

    // The complaint moved to Assigned automatically (system transition).
    await page.getByRole('link', { name: /^MV-\d{4}-\d{6}/ }).first().click();
    await expect(page.getByText('Assigned').first()).toBeVisible();
    await expect(page.getByText(workOrderNo).first()).toBeVisible();
  });

  test('the engineer accepts the job from the dashboard', async ({ page }) => {
    await signIn(page, 'engineer1@example.com');
    await expect(page.getByRole('heading', { name: 'My work' })).toBeVisible();
    const row = page.getByText(workOrderNo).first();
    await expect(row).toBeVisible();
    const accepted = page.waitForResponse((r) => r.url().includes('/transitions') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Accept/ }).first().click();
    expect((await accepted).status()).toBe(200);
    await page.goto(workOrderUrl);
    await expect(page.getByText('Accepted').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept work' })).toHaveCount(0);
  });

  test('another region\'s engineer cannot open the work order', async ({ page }) => {
    await signIn(page, 'engineer2@example.com');
    await page.goto(workOrderUrl);
    await expect(page.getByText(/not found|no access/i).first()).toBeVisible();
  });

  test('the job appears on the supervisor\'s week board', async ({ page }) => {
    await signIn(page, 'supervisor@example.com');
    await page.goto('/work-orders/board');
    await page.getByRole('group', { name: 'Board view' }).getByRole('button', { name: 'Week' }).click();
    const board = page.getByRole('grid', { name: 'Week assignment board' });
    // The board weeks run Monday–Sunday: tomorrow is in next week only when tomorrow is a Monday.
    await expect(board.getByText('Eli Engineer').first()).toBeVisible();
    if (new Date(Date.now() + 86400_000).getDay() === 1) await page.getByRole('button', { name: 'Next week' }).click();
    await expect(board.getByText(workOrderNo).first()).toBeVisible();
    await board.getByText(workOrderNo).first().click();
    await expect(page).toHaveURL(workOrderUrl);
  });
});
