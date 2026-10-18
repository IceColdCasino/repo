import type { UiGameKind } from './game-kind';

export const TABLE_CENTER = { x: 960, y: 410 };

/** Top edge of the green felt in viewBox coords (matches Poker.svelte path). */
export const FELT_TOP_Y = 150;
/** Right-inner edge of the felt. */
export const FELT_RIGHT_X = 1500;

/** Hover preview dock below the table SVG (left column). */
export const CARD_HOVER_PREVIEW_DOCK_PADDING_PX = 16;
export const CARD_HOVER_PREVIEW_TOP_PX = CARD_HOVER_PREVIEW_DOCK_PADDING_PX;
export const CARD_HOVER_PREVIEW_TARGET_HEIGHT_PX = 400;
export const CARD_HOVER_PREVIEW_TARGET_WIDTH_PX = 300;
export const CARD_HOVER_PREVIEW_OFFSET_X_PX = 24;
export const CARD_HOVER_PREVIEW_MIN_GAP_PX = 16;
/** ViewBox X used to align the preview's right edge with the table. */
export const CARD_HOVER_PREVIEW_ANCHOR = { x: 1860, y: 20 };
/** Shared community card size in viewBox units (for aspect ratio). */
export const CARD_HOVER_PREVIEW_VIEWBOX_SIZE = { w: 96, h: 128 };

/** Seat avatar display size on the table (matches style.css --dimension). */
export const TABLE_AVATAR_DISPLAY_PX = 60;
export const AVATAR_HOVER_PREVIEW_SCALE = 3;
export const AVATAR_HOVER_PREVIEW_SIZE_PX = TABLE_AVATAR_DISPLAY_PX * AVATAR_HOVER_PREVIEW_SCALE;
export const SEAT_COUNT = 10;
export const SEAT_CIRCLE_RADIUS = 32;
export const DEALER_BUTTON_RADIUS = 20;
export const HOLE_CARD_SIZE = { w: 58, h: 78, step: 70 };
export const HOLE_CLUSTER_SIZE = { w: HOLE_CARD_SIZE.w + HOLE_CARD_SIZE.step, h: HOLE_CARD_SIZE.h };
/** Phase / street label sits in the open felt above the pot, clear of top hole cards. */
export const PHASE_LABEL = { x: TABLE_CENTER.x, y: 298 };

/** Avatar circles on the outside rail of the table. */
export const avatarCirclePositions = [
  { cx: 1160, cy: 100 },
  { cx: 1560, cy: 100 },
  { cx: 1850, cy: 420 },
  { cx: 1560, cy: 720 },
  { cx: 1160, cy: 720 },
  { cx: 760, cy: 720 },
  { cx: 360, cy: 720 },
  { cx: 70, cy: 420 },
  { cx: 360, cy: 100 },
  { cx: 760, cy: 100 },
] as const;

/** @deprecated Use avatarCirclePositions */
export const seatCirclePositions = avatarCirclePositions;

/**
 * Hole-card cluster top-left (inside the felt).
 * Centered on the seat, inset far enough for the dealer button to sit
 * between the avatar and the cards without overlapping either.
 */
export const playerCardPositions = [
  { x: 1096, y: 192 },
  { x: 1496, y: 192 },
  { x: 1630, y: 368 },
  { x: 1496, y: 550 },
  { x: 1096, y: 550 },
  { x: 696, y: 550 },
  { x: 296, y: 550 },
  { x: 162, y: 368 },
  { x: 296, y: 192 },
  { x: 696, y: 192 },
] as const;

export const sharedCardPositions = [
  { id: 'flop0', x: 688, y: 350 },
  { id: 'flop1', x: 800, y: 350 },
  { id: 'flop2', x: 912, y: 350 },
  { id: 'turn', x: 1024, y: 350 },
  { id: 'river', x: 1136, y: 350 },
] as const;

export type SeatBand = 'top' | 'bottom' | 'left' | 'right';

export function seatBand(seat: number): SeatBand {
  if (seat === 2) {
    return 'right';
  }
  if (seat === 7) {
    return 'left';
  }
  if (seat <= 1 || seat >= 8) {
    return 'top';
  }
  return 'bottom';
}

const DEALER_INSET = SEAT_CIRCLE_RADIUS + 10 + DEALER_BUTTON_RADIUS;

/** Dealer button sits in the gap between the avatar and that seat's hole cards. */
export const dealerButtonPositions = avatarCirclePositions.map((avatar, seat) => {
  const band = seatBand(seat);
  if (band === 'top') {
    return { cx: avatar.cx, cy: avatar.cy + DEALER_INSET };
  }
  if (band === 'bottom') {
    return { cx: avatar.cx, cy: avatar.cy - DEALER_INSET };
  }
  if (band === 'right') {
    return { cx: avatar.cx - DEALER_INSET, cy: avatar.cy };
  }
  return { cx: avatar.cx + DEALER_INSET, cy: avatar.cy };
});

export type SeatTextAnchor = 'start' | 'middle' | 'end';

export function seatIdentityLayout(seat: number): {
  nameX: number;
  nameY: number;
  chipX: number;
  chipY: number;
  anchor: SeatTextAnchor;
} {
  const avatar = avatarCirclePositions[seat]!;
  const band = seatBand(seat);
  if (band === 'top') {
    const nameY = avatar.cy - SEAT_CIRCLE_RADIUS - 8;
    return { nameX: avatar.cx, nameY, chipX: avatar.cx, chipY: nameY - 16, anchor: 'middle' };
  }
  const start = avatar.cy + SEAT_CIRCLE_RADIUS + (band === 'bottom' ? 12 : 22);
  return { nameX: avatar.cx, nameY: start, chipX: avatar.cx, chipY: start + 16, anchor: 'middle' };
}

/** Bet / won / hand sit beside the hole cards, away from the board and avatar. */
export function seatStatusLayout(
  seat: number,
  line: number,
): { x: number; y: number; anchor: SeatTextAnchor } {
  const cards = playerCardPositions[seat]!;
  const avatar = avatarCirclePositions[seat]!;
  const band = seatBand(seat);
  const y = cards.y + 16 + line * 15;
  if (band === 'left') {
    return { x: cards.x + HOLE_CLUSTER_SIZE.w + 10, y, anchor: 'start' };
  }
  if (band === 'right') {
    return { x: cards.x - 10, y, anchor: 'end' };
  }
  const outward = avatar.cx >= TABLE_CENTER.x ? 1 : -1;
  return {
    x: outward > 0 ? cards.x + HOLE_CLUSTER_SIZE.w + 10 : cards.x - 10,
    y,
    anchor: outward > 0 ? 'start' : 'end',
  };
}

export function seatLabel(seatIndex: number): string {
  return `Seat ${seatIndex + 1}`;
}

export function formatChipBalance(chips: number): string {
  return chips.toLocaleString('en-US');
}

export type Point = { cx: number; cy: number };
export type CardOrigin = { x: number; y: number; id?: string };

export type TableLayout = {
  seatCount: number;
  avatars: readonly Point[];
  playerCards: readonly CardOrigin[];
  dealerButtons: readonly Point[];
  sharedCards: readonly CardOrigin[];
  dealerCards: readonly CardOrigin[];
  versusPlayerCards: readonly CardOrigin[];
  band: (seat: number) => SeatBand;
};

function dealerButtonAt(avatar: Point, band: SeatBand): Point {
  if (band === 'top') {
    return { cx: avatar.cx, cy: avatar.cy + DEALER_INSET };
  }
  if (band === 'bottom') {
    return { cx: avatar.cx, cy: avatar.cy - DEALER_INSET };
  }
  if (band === 'right') {
    return { cx: avatar.cx - DEALER_INSET, cy: avatar.cy };
  }
  return { cx: avatar.cx + DEALER_INSET, cy: avatar.cy };
}

function pokerBand(seat: number): SeatBand {
  return seatBand(seat);
}

function twelveSeatBand(seat: number): SeatBand {
  if (seat === 2 || seat === 11) {
    return 'right';
  }
  if (seat === 7 || seat === 10) {
    return 'left';
  }
  if (seat <= 1 || seat === 8 || seat === 9) {
    return 'top';
  }
  return 'bottom';
}

function blackjackBand(seat: number): SeatBand {
  return seat === 0 ? 'top' : 'bottom';
}

function layoutFromAvatars(
  avatars: readonly Point[],
  cards: readonly CardOrigin[],
  band: (seat: number) => SeatBand,
  extras: Pick<TableLayout, 'sharedCards' | 'dealerCards' | 'versusPlayerCards'>,
): TableLayout {
  return {
    seatCount: avatars.length,
    avatars,
    playerCards: cards,
    dealerButtons: avatars.map((avatar, seat) => dealerButtonAt(avatar, band(seat))),
    band,
    ...extras,
  };
}

const POKER_SHARED: readonly CardOrigin[] = sharedCardPositions;

/** Baccarat banker (3) / War dealer (first 2). Centered on the felt. */
export const VERSUS_DEALER_CARD_POSITIONS: readonly CardOrigin[] = [
  { id: 'dealer0', x: 780, y: 200 },
  { id: 'dealer1', x: 868, y: 200 },
  { id: 'dealer2', x: 956, y: 200 },
];

/** Baccarat player (3) / War player (first 2). Independent of seat. */
export const VERSUS_PLAYER_CARD_POSITIONS: readonly CardOrigin[] = [
  { id: 'versus0', x: 780, y: 520 },
  { id: 'versus1', x: 868, y: 520 },
  { id: 'versus2', x: 956, y: 520 },
];

export const WAR_DEALER_CARD_POSITIONS = VERSUS_DEALER_CARD_POSITIONS.slice(0, 2);
export const WAR_PLAYER_CARD_POSITIONS = VERSUS_PLAYER_CARD_POSITIONS.slice(0, 2);
export const BACCARAT_DEALER_CARD_POSITIONS = VERSUS_DEALER_CARD_POSITIONS;
export const BACCARAT_PLAYER_CARD_POSITIONS = VERSUS_PLAYER_CARD_POSITIONS;

/** Blackjack dealer hand at the top; hole card is index 1. */
export const BLACKJACK_DEALER_CARD_POSITIONS: readonly CardOrigin[] = [
  { id: 'bj-up', x: 860, y: 198 },
  { id: 'bj-hole', x: 948, y: 198 },
  { id: 'bj-hit0', x: 1036, y: 198 },
  { id: 'bj-hit1', x: 1124, y: 198 },
];

export const ROULETTE_RESULT_CARD: CardOrigin = { id: 'roulette-result', x: 912, y: 168 };

/**
 * 12-seat rail: poker 10 plus two extra side seats.
 * The original left/right seats move above the horizontal center; the new
 * pair sits below the line.
 */
const TWELVE_AVATARS: readonly Point[] = [
  { cx: 1160, cy: 100 },
  { cx: 1560, cy: 100 },
  { cx: 1850, cy: 340 },
  { cx: 1560, cy: 720 },
  { cx: 1160, cy: 720 },
  { cx: 760, cy: 720 },
  { cx: 360, cy: 720 },
  { cx: 70, cy: 340 },
  { cx: 360, cy: 100 },
  { cx: 760, cy: 100 },
  { cx: 70, cy: 500 },
  { cx: 1850, cy: 500 },
];

const BLACKJACK_AVATARS: readonly Point[] = [
  { cx: 960, cy: 100 },
  { cx: 1680, cy: 620 },
  { cx: 1460, cy: 730 },
  { cx: 1210, cy: 750 },
  { cx: 960, cy: 760 },
  { cx: 710, cy: 750 },
  { cx: 460, cy: 730 },
  { cx: 240, cy: 620 },
];

const BLACKJACK_CARDS: readonly CardOrigin[] = [
  { x: 896, y: 192 },
  { x: 1540, y: 500 },
  { x: 1396, y: 548 },
  { x: 1146, y: 548 },
  { x: 896, y: 548 },
  { x: 646, y: 548 },
  { x: 396, y: 548 },
  { x: 200, y: 500 },
];

const POKER_LAYOUT = layoutFromAvatars(
  avatarCirclePositions,
  playerCardPositions,
  pokerBand,
  {
    sharedCards: POKER_SHARED,
    dealerCards: [],
    versusPlayerCards: [],
  },
);

const EMPTY_SEAT_CARDS: readonly CardOrigin[] = [];

function twelveRailLayout(
  extras: Pick<TableLayout, 'sharedCards' | 'dealerCards' | 'versusPlayerCards'>,
): TableLayout {
  return layoutFromAvatars(TWELVE_AVATARS, EMPTY_SEAT_CARDS, twelveSeatBand, extras);
}

const WAR_LAYOUT = twelveRailLayout({
  sharedCards: [],
  dealerCards: WAR_DEALER_CARD_POSITIONS,
  versusPlayerCards: WAR_PLAYER_CARD_POSITIONS,
});

const BACCARAT_LAYOUT = twelveRailLayout({
  sharedCards: [],
  dealerCards: BACCARAT_DEALER_CARD_POSITIONS,
  versusPlayerCards: BACCARAT_PLAYER_CARD_POSITIONS,
});

const ROULETTE_LAYOUT = twelveRailLayout({
  sharedCards: [ROULETTE_RESULT_CARD],
  dealerCards: [],
  versusPlayerCards: [],
});

const BLACKJACK_LAYOUT = layoutFromAvatars(
  BLACKJACK_AVATARS,
  BLACKJACK_CARDS,
  blackjackBand,
  {
    sharedCards: BLACKJACK_DEALER_CARD_POSITIONS,
    dealerCards: BLACKJACK_DEALER_CARD_POSITIONS,
    versusPlayerCards: [],
  },
);

export function tableLayoutFor(kind: UiGameKind): TableLayout {
  if (kind === 'blackjack') {
    return BLACKJACK_LAYOUT;
  }
  if (kind === 'war') {
    return WAR_LAYOUT;
  }
  if (kind === 'baccarat') {
    return BACCARAT_LAYOUT;
  }
  if (kind === 'roulette') {
    return ROULETTE_LAYOUT;
  }
  return POKER_LAYOUT;
}

export function seatIdentityLayoutFor(
  seat: number,
  layout: TableLayout = POKER_LAYOUT,
): {
  nameX: number;
  nameY: number;
  chipX: number;
  chipY: number;
  anchor: SeatTextAnchor;
} {
  const avatar = layout.avatars[seat];
  if (!avatar) {
    return { nameX: 0, nameY: 0, chipX: 0, chipY: 0, anchor: 'middle' };
  }
  const band = layout.band(seat);
  if (band === 'top') {
    const nameY = avatar.cy - SEAT_CIRCLE_RADIUS - 8;
    return { nameX: avatar.cx, nameY, chipX: avatar.cx, chipY: nameY - 16, anchor: 'middle' };
  }
  const start = avatar.cy + SEAT_CIRCLE_RADIUS + (band === 'bottom' ? 12 : 22);
  return { nameX: avatar.cx, nameY: start, chipX: avatar.cx, chipY: start + 16, anchor: 'middle' };
}

export function seatStatusLayoutFor(
  seat: number,
  line: number,
  layout: TableLayout = POKER_LAYOUT,
): { x: number; y: number; anchor: SeatTextAnchor } {
  const cards = layout.playerCards[seat] ?? { x: 0, y: 0 };
  const avatar = layout.avatars[seat] ?? TABLE_CENTER;
  const band = layout.band(seat);
  const y = cards.y + 16 + line * 15;
  if (band === 'left') {
    return { x: cards.x + HOLE_CLUSTER_SIZE.w + 10, y, anchor: 'start' };
  }
  if (band === 'right') {
    return { x: cards.x - 10, y, anchor: 'end' };
  }
  const outward = avatar.cx >= TABLE_CENTER.x ? 1 : -1;
  return {
    x: outward > 0 ? cards.x + HOLE_CLUSTER_SIZE.w + 10 : cards.x - 10,
    y,
    anchor: outward > 0 ? 'start' : 'end',
  };
}
