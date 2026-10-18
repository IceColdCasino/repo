/// <reference types="vitest/globals" />
import { describe, expect, it } from 'vitest';
import {
  CARD_HOVER_PREVIEW_TARGET_HEIGHT_PX,
  CARD_HOVER_PREVIEW_TARGET_WIDTH_PX,
} from './table-layout';
import {
  computeCardHoverPreviewLayout,
  computeAvatarHoverPreviewLayout,
  dockedAvatarHoverPreviewLayout,
  dockedCardHoverPreviewLayout,
  previewAspectRatio,
  TABLE_BELOW_BAND_PX,
} from './card-hover-preview-layout';
import {
  AVATAR_HOVER_PREVIEW_SIZE_PX,
  AVATAR_HOVER_PREVIEW_SCALE,
  TABLE_AVATAR_DISPLAY_PX,
} from './table-layout';

describe('card hover preview layout', () => {
  it('reserves below-band space for preview + hand result', () => {
    expect(TABLE_BELOW_BAND_PX).toBe(CARD_HOVER_PREVIEW_TARGET_HEIGHT_PX + 16);
    expect(TABLE_BELOW_BAND_PX).toBe(416);
  });

  it('renders a 400×300 preview aligned to the mapped anchor X', () => {
    const layout = computeCardHoverPreviewLayout(1600);
    expect(layout.width).toBe(CARD_HOVER_PREVIEW_TARGET_WIDTH_PX);
    expect(layout.height).toBe(CARD_HOVER_PREVIEW_TARGET_HEIGHT_PX);
    expect(layout.x).toBe(1624);
    expect(layout.fontSize).toBeGreaterThan(250);
  });

  it('docked preview fills the left slot under the table', () => {
    const layout = dockedCardHoverPreviewLayout();
    expect(layout.width).toBe(CARD_HOVER_PREVIEW_TARGET_WIDTH_PX);
    expect(layout.height).toBe(CARD_HOVER_PREVIEW_TARGET_HEIGHT_PX);
    expect(layout.x).toBe(0);
    expect(layout.y).toBe(0);
  });

  it('keeps playing-card aspect ratio', () => {
    const layout = computeCardHoverPreviewLayout(1200);
    expect(layout.width / layout.height).toBeCloseTo(previewAspectRatio(), 5);
  });

  it('renders avatar preview at 3× table size in the dock', () => {
    expect(AVATAR_HOVER_PREVIEW_SIZE_PX).toBe(TABLE_AVATAR_DISPLAY_PX * AVATAR_HOVER_PREVIEW_SCALE);
    const layout = dockedAvatarHoverPreviewLayout();
    expect(layout.width).toBe(180);
    expect(layout.height).toBe(180);
    expect(layout.x).toBe(0);
    expect(layout.y).toBe(0);
    const legacy = computeAvatarHoverPreviewLayout(1500);
    expect(legacy.width).toBe(180);
  });
});
