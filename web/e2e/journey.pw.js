import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

async function choose(dialog, label, value) {
  const control = dialog.locator('label.field').filter({ hasText: label });
  await control.locator('.select-btn').click();
  await control.locator('.select-opt').filter({ hasText: new RegExp(`^${value}(?:\\s|$)`) }).click();
}

test('регистрация, сохранение пары и создание правила', async ({ page }) => {
  const email = `browser-${randomUUID()}@example.test`;
  const password = 'local-browser-test-password';
  await page.goto('/');
  await page.getByRole('button', { name: 'Регистрация', exact: true }).click();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Добавить пару', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await choose(dialog, 'Базовый актив', 'BTC');
  await choose(dialog, 'Котируемый актив', 'USDT');
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toBeHidden();
  const pair = page.locator('#watchlist').getByText(/BTC\s*\/\s*USDT/);
  await expect(pair).toBeVisible();
  await pair.click();
  await expect(page.locator('#pair-rate')).toHaveText(/\d/);

  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.getByRole('button', { name: 'Вход', exact: true }).click();
  await expect(page.locator('#auth-email')).toBeVisible();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await expect(pair).toBeVisible();
  await pair.click();
  await expect(page.locator('#pair-rate')).toHaveText(/\d/);

  await page.locator('#alert-value').fill('123456');
  await page.getByRole('button', { name: 'Добавить правило', exact: true }).click();
  const rules = page.locator('#alerts-list');
  await expect(rules).toContainText(/выше/i);
  await expect(rules).toContainText(/123[\s\u00a0\u202f]?456/);
});
