import {
  CARD_HOVER_PREVIEW_MIN_GAP_PX,
  CARD_HOVER_PREVIEW_OFFSET_X_PX,
  CARD_HOVER_PREVIEW_TARGET_HEIGHT_PX,
  CARD_HOVER_PREVIEW_TARGET_WIDTH_PX,
  CARD_HOVER_PREVIEW_TOP_PX,
  CARD_HOVER_PREVIEW_VIEWBOX_SIZE,
  FELT_TOP_Y,
  AVATAR_HOVER_PREVIEW_SIZE_PX,
} from './table-layout';

export interface CardHoverPreviewLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

/** Space reserved below the table for preview + hand-result band. */
export const TABLE_BELOW_BAND_PX =
  CARD_HOVER_PREVIEW_TARGET_HEIGHT_PX + CARD_HOVER_PREVIEW_MIN_GAP_PX;

/** @deprecated Preview no longer lives in the header; use TABLE_BELOW_BAND_PX. */
export const TABLE_HEADER_STACK_PX = TABLE_BELOW_BAND_PX;

export function computeCardHoverPreviewLayout(anchorScreenX: number): CardHoverPreviewLayout {
  const height = CARD_HOVER_PREVIEW_TARGET_HEIGHT_PX;
  const width = CARD_HOVER_PREVIEW_TARGET_WIDTH_PX;
  return {
    x: anchorScreenX + CARD_HOVER_PREVIEW_OFFSET_X_PX,
    y: CARD_HOVER_PREVIEW_TOP_PX,
    width,
    height,
    fontSize: Math.round(height * 0.72),
  };
}

/** Dimensions for the docked preview slot under the table. */
export function dockedCardHoverPreviewLayout(): CardHoverPreviewLayout {
  const height = CARD_HOVER_PREVIEW_TARGET_HEIGHT_PX;
  const width = CARD_HOVER_PREVIEW_TARGET_WIDTH_PX;
  return {
    x: 0,
    y: 0,
    width,
    height,
    fontSize: Math.round(height * 0.72),
  };
}

export function dockedAvatarHoverPreviewLayout(): Omit<CardHoverPreviewLayout, 'fontSize'> {
  const size = AVATAR_HOVER_PREVIEW_SIZE_PX;
  return { x: 0, y: 0, width: size, height: size };
}

export function mapViewBoxPointToScreen(
  svg: SVGSVGElement,
  x: number,
  y: number,
): { x: number; y: number } | null {
  if (typeof svg.getScreenCTM !== 'function' || typeof svg.createSVGPoint !== 'function') {
    return null;
  }
  const matrix = svg.getScreenCTM();
  if (!matrix) {
    return null;
  }
  const point = svg.createSVGPoint();
  point.x = x;
  point.y = y;
  const screen = point.matrixTransform(matrix);
  return { x: screen.x, y: screen.y };
}

export function feltTopScreenY(svg: SVGSVGElement): number | null {
  return mapViewBoxPointToScreen(svg, 1500, FELT_TOP_Y)?.y ?? null;
}

export function computeAvatarHoverPreviewLayout(anchorScreenX: number): Omit<CardHoverPreviewLayout, 'fontSize'> {
  const slot = computeCardHoverPreviewLayout(anchorScreenX);
  const size = AVATAR_HOVER_PREVIEW_SIZE_PX;
  return {
    x: slot.x,
    y: slot.y,
    width: size,
    height: size,
  };
}

export function previewAspectRatio(): number {
  return CARD_HOVER_PREVIEW_VIEWBOX_SIZE.w / CARD_HOVER_PREVIEW_VIEWBOX_SIZE.h;
}
