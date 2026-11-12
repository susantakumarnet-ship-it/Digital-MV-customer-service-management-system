import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const ADMIN = { id: 'admin', password: 'E2e-Admin-Passw0rd', newPassword: 'E2e-Admin-Changed-1' };
const DEMO_PASSWORD = 'E2e-Demo-Passw0rd';

async function signIn(page: Page, identifier: string, password: string, expectSuccess = true) {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(identifier);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Wait until the session is established (refresh cookie set) before navigating elsewhere.
  if (expectSuccess) await expect(page).not.toHaveURL(/\/login/);
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 2 foundation journeys', () => {
  test('rejects invalid credentials with a clear message', async ({ page }) => {
    await signIn(page, 'admin', 'wrong-password', false);
    await expect(page.getByText('The email/username or password is incorrect.')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('first administrator sign-in forces a password change, then shows the admin dashboard', async ({ page }) => {
    await signIn(page, ADMIN.id, ADMIN.password);
    await expect(page).toHaveURL(/change-password/);
    await page.getByLabel('Current password').fill(ADMIN.password);
    await page.getByRole('textbox', { name: 'New password', exact: true }).fill(ADMIN.newPassword);
    await page.getByLabel('Confirm new password').fill(ADMIN.newPassword);
    await page.getByRole('button', { name: /change password/i }).click();
    await expect(page).toHaveURL('http://localhost:5611/');
    // KPI figures come from the database: 1 admin + 7 demo users.
    await expect(page.getByRole('heading', { name: 'Administrator dashboard', level: 1 })).toBeVisible();
    await expect(page.getByText('Failed sign-ins (24h)')).toBeVisible();
    // Real counts: "Users" card shows 8, and the security notice about the password change arrives in-app.
    await expect(page.getByText('Users', { exact: true }).locator('..').getByText('8', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /notifications/i }).click();
    await expect(page.getByText('Your password was changed')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('link', { name: 'Users' })).toBeVisible();
    await signOut(page);
  });

  test('administrator creates, edits and deactivates master data (no delete)', async ({ page }) => {
    await signIn(page, ADMIN.id, ADMIN.newPassword);
    await page.goto('/admin/masters/regions');
    await expect(page.getByRole('heading', { name: 'Regions' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'North Region', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New region' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('East Region');
    await dialog.getByLabel('Code').fill('est');
    await dialog.getByRole('button', { name: 'Create region' }).click();
    await expect(page.getByRole('cell', { name: 'East Region', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'EST', exact: true })).toBeVisible();

    // Duplicate code (case-insensitive) is rejected by the server and shown on the field.
    await page.getByRole('button', { name: 'New region' }).click();
    await dialog.getByLabel('Name').fill('Another');
    await dialog.getByLabel('Code').fill('EST');
    await dialog.getByRole('button', { name: 'Create region' }).click();
    await expect(dialog.getByText(/already/i)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Parent with active children cannot be deactivated.
    await page.getByRole('button', { name: 'Deactivate North Region' }).click();
    await page.getByRole('alertdialog').getByRole('textbox').fill('Reorganisation');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.getByText(/Cannot deactivate "North Region"/)).toBeVisible();
    // The confirm dialog stays open after a server refusal so the user can read the reason and cancel.
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('cell', { name: 'North Region', exact: true })).toBeVisible();

    await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);
    await signOut(page);
  });

  test('field engineer sees no administration menu and is refused admin pages', async ({ page }) => {
    await signIn(page, 'engineer1@example.com', DEMO_PASSWORD);
    await expect(page).toHaveURL('http://localhost:5611/');
    await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Audit Log' })).toHaveCount(0);
    await page.goto('/admin/users');
    await expect(page.getByText('You do not have access to this page')).toBeVisible();
    await signOut(page);
  });

  test('session survives a page reload (refresh cookie) and ends on sign-out', async ({ page }) => {
    await signIn(page, 'supervisor@example.com', DEMO_PASSWORD);
    await expect(page).toHaveURL('http://localhost:5611/');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
    await signOut(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('login page has no serious accessibility violations', async ({ page }) => {
    await page.goto('/login');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(' ') + ' [' + (n.any[0]?.message ?? '') + ']').join(' | ')}`)).toEqual([]);
  });
});

test('@mobile dashboard fits a phone screen without horizontal scrolling', async ({ page }) => {
  await signIn(page, 'management@example.com', DEMO_PASSWORD);
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
});
