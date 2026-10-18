import { expect, type Page } from '@playwright/test';
import {
  AVATAR_HOVER_PREVIEW_SIZE_PX,
  CARD_HOVER_PREVIEW_TARGET_HEIGHT_PX,
  CARD_HOVER_PREVIEW_TARGET_WIDTH_PX,
  FELT_TOP_Y,
} from '../../src/poker/table-layout';
import { TABLE_BELOW_BAND_PX } from '../../src/poker/card-hover-preview-layout';

export async function openConnectedTable(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('table-label')).toBeVisible({ timeout: 30_000 });
  const connect = page.getByTestId('connect-server');
  if (await connect.count()) {
    await connect.click();
  }
  await expect(page.getByTestId('poker-table')).toBeVisible({ timeout: 30_000 });
}

export async function feltTopScreenY(page: Page): Promise<number> {
  return page.evaluate((feltY) => {
    const svg = document.querySelector('[data-testid="poker-table"]') as SVGSVGElement | null;
    if (!svg || typeof svg.getScreenCTM !== 'function' || typeof svg.createSVGPoint !== 'function') {
      throw new Error('poker-table svg unavailable');
    }
    const matrix = svg.getScreenCTM();
    if (!matrix) {
      throw new Error('poker-table svg CTM unavailable');
    }
    const point = svg.createSVGPoint();
    point.x = 1500;
    point.y = feltY;
    return point.matrixTransform(matrix).y;
  }, FELT_TOP_Y);
}

export async function tableViewportTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = document.querySelector('.table-viewport');
    if (!viewport) {
      throw new Error('.table-viewport missing');
    }
    return viewport.getBoundingClientRect().top;
  });
}

export async function tableViewportBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = document.querySelector('.table-viewport');
    if (!viewport) {
      throw new Error('.table-viewport missing');
    }
    return viewport.getBoundingClientRect().bottom;
  });
}

export async function belowBandTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const band = document.querySelector('.table-below-band');
    if (!band) {
      throw new Error('.table-below-band missing');
    }
    return band.getBoundingClientRect().top;
  });
}

export const PREVIEW_LAYOUT = {
  targetHeight: CARD_HOVER_PREVIEW_TARGET_HEIGHT_PX,
  targetWidth: CARD_HOVER_PREVIEW_TARGET_WIDTH_PX,
  belowBand: TABLE_BELOW_BAND_PX,
  avatarSize: AVATAR_HOVER_PREVIEW_SIZE_PX,
};
