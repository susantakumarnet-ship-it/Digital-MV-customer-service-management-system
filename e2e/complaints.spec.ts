import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 3 journey: public submission → supervisor classifies and requests information →
 * portal customer replies → out-of-scope engineer cannot open it.
 * Uses the demo seed (North Region › Northfield › Northfield Primary Substation, owned by the
 * demo customer organisation of customer@example.com).
 */
const DEMO_PASSWORD = 'E2e-Demo-Passw0rd';
let complaintUrl = '';
let reference = '';

async function signIn(page: Page, identifier: string) {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(identifier);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Selects the option whose text contains the given text (labels may include codes). Waits for cascading options to load. */
async function pick(page: Page, name: RegExp, text: string) {
  const select = page.getByRole('combobox', { name });
  const option = select.locator('option', { hasText: text }).first();
  await expect(option).toBeAttached();
  await select.selectOption((await option.getAttribute('value'))!);
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 3 complaint lifecycle (intake → review → information request)', () => {
  test('a member of the public submits a complaint and receives a reference', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Submit a complaint online' }).click();
    await expect(page).toHaveURL(/\/report/);

    // Step 1 — contact
    await page.getByLabel('Customer name').fill('Pat Public');
    await page.getByLabel('Mobile number').fill('+44 7700 900456');
    await page.getByLabel('Email address').fill('pat.public@example.com');
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 2 — cascading location
    await pick(page, /^Region/, 'North Region');
    await pick(page, /^City/, 'Northfield');
    await pick(page, /^Site/, 'Northfield Primary Substation');
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 3 — request (invalid first: description too short)
    await pick(page, /^Request type/, 'Breakdown / Fault');
    await page.getByLabel('Describe the problem').fill('Short');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText(/at least 10 characters/)).toBeVisible();
    await page.getByLabel('Describe the problem').fill('Ring main unit alarm sounding continuously since 6am.');
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 4 — consent is mandatory
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText(/accept the privacy notice/i)).toBeVisible();
    await page.getByRole('checkbox', { name: /privacy notice/ }).check();
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 5 — review & submit (the server enforces a minimum fill time)
    await page.waitForTimeout(5500);
    await page.getByRole('button', { name: 'Submit complaint' }).click();
    const ref = page.getByTestId('reference');
    await expect(ref).toHaveText(/^MV-\d{4}-\d{6}$/);
    reference = (await ref.textContent())!.trim();
  });

  test('the supervisor finds it, classifies it and requests information', async ({ page }) => {
    await signIn(page, 'supervisor@example.com');
    await page.getByRole('link', { name: 'Complaints' }).first().click();
    await page.getByLabel('Search complaints').fill(reference);
    await page.getByRole('link', { name: reference }).click();
    await expect(page.getByRole('heading', { name: new RegExp(reference) })).toBeVisible();
    complaintUrl = page.url();

    await pick(page, /^Priority/, 'Critical');
    await page.getByRole('button', { name: 'Classify & start review' }).click();
    await expect(page.getByText('Under Review').first()).toBeVisible();
    await expect(page.getByText(/Current due date/)).toBeVisible();

    await page.getByRole('group', { name: 'Workflow actions' }).or(page.locator('[aria-label="Workflow actions"]')).getByRole('button', { name: 'Request information' }).click();
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
    await dialog.getByLabel(/What information is needed/).fill('Please send a photo of the alarm panel.');
    await dialog.getByRole('button', { name: 'Request information' }).click();
    await expect(page.getByText('Awaiting Customer Information').first()).toBeVisible();
  });

  test('the portal customer replies, which returns the complaint to review', async ({ page }) => {
    await signIn(page, 'customer@example.com');
    await page.goto(complaintUrl);
    // Shown in the message thread (and as the reason in the status history).
    await expect(page.getByText('Please send a photo of the alarm panel.').first()).toBeVisible();
    await expect(page.getByText(/internal notes/i)).toHaveCount(0);
    await page.getByLabel('Your response').fill('The panel shows "SF6 LOW". Photo to follow from site team.');
    await page.getByRole('button', { name: 'Send response' }).click();
    await expect(page.getByText('Under Review').first()).toBeVisible();
  });

  test('an engineer outside the site\'s region cannot open it', async ({ page }) => {
    await signIn(page, 'engineer2@example.com'); // South region only
    await page.goto(complaintUrl);
    await expect(page.getByText(/not found|no access/i).first()).toBeVisible();
  });
});

test('public complaint form has no serious accessibility violations', async ({ page }) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  await page.goto('/report');
  await expect(page.getByLabel('Customer name')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});

test('@mobile public complaint form fits a phone screen', async ({ page }) => {
  await page.goto('/report');
  await expect(page.getByLabel('Customer name')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
