import { expect, test } from '@playwright/test';
import { resetTable } from './helpers/game-api';

const API = 'http://127.0.0.1:3847/api';

test.describe('seating flow', () => {
  async function waitForTable(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/');
    await expect(page.getByTestId('table-label')).toBeVisible({ timeout: 30_000 });
  }

  test('dropdown and Sit join a seat; avatar appears; Stand restores picker', async ({ page }) => {
    await waitForTable(page);
    await expect(page.getByTestId('seat-select')).toBeEnabled();
    await expect(page.getByTestId('sit-down')).toBeDisabled();

    await page.getByTestId('seat-select').selectOption('2');
    await expect(page.getByTestId('sit-down')).toBeEnabled();

    await page.getByTestId('sit-down').click();

    await expect(page.getByTestId('seat-select')).toHaveCount(0);
    await expect(page.getByTestId('sit-down')).toHaveCount(0);
    await expect(page.locator('[data-testid="seat-avatar-2"]')).toBeVisible();
    await expect(page.getByTestId('stand-up')).toBeVisible();

    await page.getByTestId('stand-up').click();

    await expect(page.getByTestId('seat-select')).toBeVisible();
    await expect(page.getByTestId('sit-down')).toBeVisible();
    await expect(page.locator('[data-testid="seat-avatar-2"]')).toHaveCount(0);
  });

  test('selecting a seat without Sit does not join', async ({ page }) => {
    await waitForTable(page);
    await expect(page.getByTestId('seat-select')).toBeEnabled();
    await page.getByTestId('seat-select').selectOption('4');
    await expect(page.getByTestId('sit-down')).toBeEnabled();
    await expect(page.locator('[data-testid="seat-avatar-4"]')).toHaveCount(0);
  });

  test('new browser instance shows players already seated via server events', async ({ page, request }) => {
    const carol = '33333333333333333333333333333334';
    await request.post(`${API}/games/local-table/join?backend=local`, {
      data: { seat: 6, publicKey: carol },
    });
    await request.post(`${API}/games/local-table/add-chips?backend=local`, {
      data: { seat: 6, amount: '1500' },
    });

    await page.goto('/');
    await expect(page.getByTestId('table-label')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="seat-avatar-6"]')).toBeVisible();
    await expect(page.getByTestId('seat-wallet-6')).toBeVisible();
    await expect(page.getByTestId('seat-chips-6')).toHaveText('1,500 chips');
  });
});

test.describe('hand order (server enforced)', () => {
  test.beforeEach(async ({ request }) => {
    await resetTable(request);
  });

  test('player index differs from table seat after start', async ({ request }) => {
    const gameId = 'local-table';
    const alice = '11111111111111111111111111111112';
    const bob = '22222222222222222222222222222223';
    const carol = '33333333333333333333333333333334';

    for (const publicKey of [alice, bob, carol]) {
      await request.post(`${API}/games/${gameId}/stand?backend=local`, {
        data: { publicKey },
      });
    }

    await request.post(`${API}/games/${gameId}/join?backend=local`, {
      data: { seat: 2, publicKey: alice },
    });
    await request.post(`${API}/games/${gameId}/join?backend=local`, {
      data: { seat: 5, publicKey: bob },
    });
    await request.post(`${API}/games/${gameId}/add-chips?backend=local`, {
      data: { seat: 2, amount: '500' },
    });
    await request.post(`${API}/games/${gameId}/add-chips?backend=local`, {
      data: { seat: 5, amount: '500' },
    });

    const startRes = await request.post(`${API}/games/${gameId}/start?backend=local`);
    expect(startRes.ok()).toBeTruthy();
    const state = await startRes.json() as {
      playerIndexBySeat: Record<string, number>;
      actionOrder: number[];
      currentPlayerSeat: number;
      currentPlayerIndex: number;
    };

    expect(state.actionOrder.length).toBe(2);
    expect(state.playerIndexBySeat['2']).not.toBe(2);
    expect(state.playerIndexBySeat['5']).not.toBe(5);
    expect(state.currentPlayerIndex).toBe(
      state.playerIndexBySeat[String(state.currentPlayerSeat)],
    );

    const wrongSeat = state.actionOrder.find((seat) => seat !== state.currentPlayerSeat)!;
    const badBet = await request.post(`${API}/games/${gameId}/action?backend=local`, {
      data: { seat: wrongSeat, action: 'fold' },
    });
    expect(badBet.ok()).toBe(false);
  });
});
