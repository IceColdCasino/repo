import { expect, test } from '@playwright/test';
import { resetTable } from './helpers/game-api';

async function waitForTable(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('table-label')).toBeVisible({ timeout: 30_000 });
}

async function sitAtSeat(page: import('@playwright/test').Page, seat: number): Promise<void> {
  await page.getByTestId('seat-select').selectOption(String(seat));
  await page.getByTestId('sit-down').click();
  await expect(page.locator(`[data-testid="seat-avatar-${seat}"]`)).toBeVisible();
  await page.getByTestId('add-chips-submit').click();
}

test.describe('two app instances at one table', () => {
  test.beforeEach(async ({ request }) => {
    await resetTable(request);
  });

  test('separate instances get distinct wallets and both appear at the table', async ({ browser }) => {
    const playerA = await browser.newPage();
    const playerB = await browser.newPage();

    await waitForTable(playerA);
    await waitForTable(playerB);

    const walletA = await playerA.getByTestId('player-public-key').textContent();
    const walletB = await playerB.getByTestId('player-public-key').textContent();
    expect(walletA).toBeTruthy();
    expect(walletB).toBeTruthy();
    expect(walletA).not.toEqual(walletB);

    await sitAtSeat(playerA, 0);
    await sitAtSeat(playerB, 1);

    await expect(playerA.locator('[data-testid="seat-avatar-1"]')).toBeVisible({ timeout: 10_000 });
    await expect(playerB.locator('[data-testid="seat-avatar-0"]')).toBeVisible({ timeout: 10_000 });

    await expect(playerA.getByTestId('stand-up')).toBeVisible();
    await expect(playerB.getByTestId('stand-up')).toBeVisible();

    await playerA.close();
    await playerB.close();
  });

  test('each instance sees seats taken by the other players', async ({ browser }) => {
    const playerA = await browser.newPage();
    const playerB = await browser.newPage();

    await waitForTable(playerA);
    await waitForTable(playerB);
    await sitAtSeat(playerA, 0);
    await sitAtSeat(playerB, 1);

    const playerC = await browser.newPage();
    await waitForTable(playerC);

    const seatValues = await playerC.getByTestId('seat-select').locator('option').evaluateAll(
      (options) => options.map((option) => option.getAttribute('value')),
    );
    expect(seatValues).not.toContain('0');
    expect(seatValues).not.toContain('1');
    expect(seatValues).toContain('2');

    await sitAtSeat(playerC, 2);
    await expect(playerA.locator('[data-testid="seat-avatar-2"]')).toBeVisible({ timeout: 10_000 });
    await expect(playerB.locator('[data-testid="seat-avatar-2"]')).toBeVisible({ timeout: 10_000 });

    await playerA.close();
    await playerB.close();
    await playerC.close();
  });
});
