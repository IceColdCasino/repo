import { expect, test } from '@playwright/test';
import {
  playThroughToPhase,
  setupTwoPlayerTable,
  startHand,
} from './helpers/game-api';
import {
  belowBandTop,
  openConnectedTable,
  PREVIEW_LAYOUT,
  tableViewportBottom,
} from './helpers/preview-layout';
test.describe('card hover preview layout', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ request }) => {
    await setupTwoPlayerTable(request);
    await startHand(request);
    await playThroughToPhase(request, 'Flop');
  });

  async function openTableWithFlop(page: import('@playwright/test').Page): Promise<void> {
    await openConnectedTable(page);
    await expect(page.getByTestId('shared-card-0')).toBeVisible({ timeout: 30_000 });
  }

  test('preview dock sits below the table and renders at 400px', async ({ page }) => {
    await openTableWithFlop(page);

    const [viewportBottom, bandTop] = await Promise.all([
      tableViewportBottom(page),
      belowBandTop(page),
    ]);

    expect(bandTop).toBeGreaterThanOrEqual(viewportBottom - 2);

    await page.getByTestId('shared-card-0').hover();
    const preview = page.getByTestId('card-hover-preview');
    await expect(preview).toBeVisible();

    const box = await preview.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(PREVIEW_LAYOUT.targetHeight - 4);
    expect(box!.height).toBeLessThan(PREVIEW_LAYOUT.targetHeight + 4);
    expect(box!.width).toBeGreaterThan(PREVIEW_LAYOUT.targetWidth - 4);
    expect(box!.width).toBeLessThan(PREVIEW_LAYOUT.targetWidth + 4);
    expect(box!.y).toBeGreaterThanOrEqual(viewportBottom - 2);
    expect(box!.x).toBeLessThanOrEqual(320);

    await expect(page).toHaveScreenshot('card-hover-preview-flop.png', {
      maxDiffPixelRatio: 0.03,
    });
  });

  test('core table elements stay visible when preview is shown', async ({ page }) => {
    await openTableWithFlop(page);

    await page.getByTestId('shared-card-1').hover();
    await expect(page.getByTestId('card-hover-preview')).toBeVisible();

    await expect(page.getByTestId('poker-table')).toBeVisible();
    await expect(page.getByTestId('game-phase-label')).toBeVisible();
    await expect(page.getByTestId('shared-card-0')).toBeVisible();
    await expect(page.getByTestId('shared-card-2')).toBeVisible();
    await expect(page.getByTestId('fold')).toBeVisible();
    await expect(page.getByTestId('toolbar')).toBeVisible();

    const [viewportBottom, previewBox, sharedBox] = await Promise.all([
      tableViewportBottom(page),
      page.getByTestId('card-hover-preview').boundingBox(),
      page.getByTestId('shared-card-1').boundingBox(),
    ]);
    expect(previewBox).not.toBeNull();
    expect(sharedBox).not.toBeNull();
    expect(previewBox!.y).toBeGreaterThanOrEqual(viewportBottom - 2);
    expect(previewBox!.y).toBeGreaterThan(sharedBox!.y + sharedBox!.height);
  });

  test('preview hides after pointer leaves card', async ({ page }) => {
    await openTableWithFlop(page);
    const card = page.getByTestId('shared-card-0');
    await card.hover();
    await expect(page.getByTestId('card-hover-preview')).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page.getByTestId('card-hover-preview')).toHaveCount(0);
  });

  test('seat avatar hover shows 3× punk in preview dock under table', async ({ page }) => {
    await openTableWithFlop(page);
    await expect(page.getByTestId('seat-avatar-0')).toBeVisible();

    await page.getByTestId('seat-avatar-0').hover();
    const preview = page.getByTestId('avatar-hover-preview');
    await expect(preview).toBeVisible();
    await expect(page.getByTestId('card-hover-preview')).toHaveCount(0);

    const [viewportBottom, box] = await Promise.all([
      tableViewportBottom(page),
      preview.boundingBox(),
    ]);
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(PREVIEW_LAYOUT.avatarSize - 4);
    expect(box!.width).toBeLessThan(PREVIEW_LAYOUT.avatarSize + 4);
    expect(box!.height).toBeCloseTo(PREVIEW_LAYOUT.avatarSize, 0);
    expect(box!.y).toBeGreaterThanOrEqual(viewportBottom - 2);
    expect(box!.x).toBeLessThanOrEqual(320);

    await expect(page).toHaveScreenshot('avatar-hover-preview-seat0.png', {
      maxDiffPixelRatio: 0.03,
    });
  });
});

test.describe('card hover preview on hole cards', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('hole-card hover shows preview in dock below table', async ({ page, request }) => {
    await setupTwoPlayerTable(request);
    await startHand(request);
    await openConnectedTable(page);

    await expect(page.locator('[data-testid="hole-card-0-0"]')).toBeVisible({ timeout: 30_000 });

    await page.locator('[data-testid="hole-card-0-0"]').hover();
    const preview = page.getByTestId('card-hover-preview');
    await expect(preview).toBeVisible();

    const [previewBox, viewportBottom] = await Promise.all([
      preview.boundingBox(),
      tableViewportBottom(page),
    ]);
    expect(previewBox).not.toBeNull();
    expect(previewBox!.height).toBeCloseTo(PREVIEW_LAYOUT.targetHeight, 0);
    expect(previewBox!.y).toBeGreaterThanOrEqual(viewportBottom - 2);

    await expect(page).toHaveScreenshot('card-hover-preview-hole-card.png', {
      maxDiffPixelRatio: 0.03,
    });
  });
});
