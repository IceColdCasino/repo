/// <reference types="vitest/globals" />
import { describe, expect, it } from 'vitest';
import {
  DEALER_BUTTON_RADIUS,
  HOLE_CLUSTER_SIZE,
  PHASE_LABEL,
  SEAT_CIRCLE_RADIUS,
  SEAT_COUNT,
  avatarCirclePositions,
  dealerButtonPositions,
  playerCardPositions,
  seatIdentityLayout,
  seatIdentityLayoutFor,
  seatStatusLayout,
  sharedCardPositions,
  tableLayoutFor,
} from './table-layout';

type Box = { x1: number; y1: number; x2: number; y2: number; id: string };

function overlaps(a: Box, b: Box, pad = 0): boolean {
  return a.x1 < b.x2 - pad && a.x2 > b.x1 + pad && a.y1 < b.y2 - pad && a.y2 > b.y1 + pad;
}

function circleBox(cx: number, cy: number, r: number, id: string): Box {
  return { x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r, id };
}

function textBox(x: number, y: number, width: number, height: number, anchor: string, id: string): Box {
  const left = anchor === 'end' ? x - width : anchor === 'start' ? x : x - width / 2;
  return { x1: left, y1: y - height + 3, x2: left + width, y2: y + 3, id };
}

function seatBoxes(seat: number): Box[] {
  const avatar = avatarCirclePositions[seat]!;
  const cards = playerCardPositions[seat]!;
  const dealer = dealerButtonPositions[seat]!;
  const ident = seatIdentityLayout(seat);
  return [
    circleBox(avatar.cx, avatar.cy, SEAT_CIRCLE_RADIUS, `seat${seat}-avatar`),
    circleBox(dealer.cx, dealer.cy, DEALER_BUTTON_RADIUS, `seat${seat}-dealer`),
    {
      x1: cards.x,
      y1: cards.y,
      x2: cards.x + HOLE_CLUSTER_SIZE.w,
      y2: cards.y + HOLE_CLUSTER_SIZE.h,
      id: `seat${seat}-cards`,
    },
    textBox(ident.nameX, ident.nameY, 110, 14, ident.anchor, `seat${seat}-name`),
    { x1: ident.chipX - 52, y1: ident.chipY - 13, x2: ident.chipX + 52, y2: ident.chipY + 5, id: `seat${seat}-chips` },
    ...[0, 1, 2].map((line) => {
      const status = seatStatusLayout(seat, line);
      return textBox(status.x, status.y, 72, 13, status.anchor, `seat${seat}-status${line}`);
    }),
  ];
}

describe('table seat chrome does not overlap', () => {
  it('keeps avatar, dealer, cards, and seat text apart at every seat', () => {
    const collisions: string[] = [];
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      const boxes = seatBoxes(seat);
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          if (a.id.includes('status') && b.id.includes('status')) {
            continue;
          }
          if (overlaps(a, b)) {
            collisions.push(`${a.id} ∩ ${b.id}`);
          }
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('keeps hole cards and seat chrome off the board and phase label', () => {
    const board: Box[] = sharedCardPositions.map((card) => ({
      x1: card.x,
      y1: card.y,
      x2: card.x + 96,
      y2: card.y + 128,
      id: card.id,
    }));
    const phase: Box = { x1: 760, y1: PHASE_LABEL.y - 24, x2: 1160, y2: PHASE_LABEL.y + 6, id: 'phase' };
    const collisions: string[] = [];
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      for (const box of seatBoxes(seat)) {
        if (overlaps(box, phase)) {
          collisions.push(`${box.id} ∩ phase`);
        }
        for (const card of board) {
          if (overlaps(box, card)) {
            collisions.push(`${box.id} ∩ ${card.id}`);
          }
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('moves 12-seat side chairs off the center line and adds a pair below', () => {
    const layout = tableLayoutFor('war');
    expect(layout.seatCount).toBe(12);
    expect(layout.avatars[2]!.cy).toBeLessThan(410);
    expect(layout.avatars[7]!.cy).toBeLessThan(410);
    expect(layout.avatars[10]!.cy).toBeGreaterThan(410);
    expect(layout.avatars[11]!.cy).toBeGreaterThan(410);
  });

  it('keeps 12-seat chrome from overlapping itself', () => {
    const layout = tableLayoutFor('baccarat');
    expect(layout.playerCards).toHaveLength(0);
    expect(layout.dealerCards).toHaveLength(3);
    expect(layout.versusPlayerCards).toHaveLength(3);
    const collisions: string[] = [];
    for (let seat = 0; seat < layout.seatCount; seat += 1) {
      const avatar = layout.avatars[seat]!;
      const dealer = layout.dealerButtons[seat]!;
      const ident = seatIdentityLayoutFor(seat, layout);
      const boxes: Box[] = [
        circleBox(avatar.cx, avatar.cy, SEAT_CIRCLE_RADIUS, `seat${seat}-avatar`),
        circleBox(dealer.cx, dealer.cy, DEALER_BUTTON_RADIUS, `seat${seat}-dealer`),
        textBox(ident.nameX, ident.nameY, 110, 14, ident.anchor, `seat${seat}-name`),
      ];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          if (overlaps(boxes[i]!, boxes[j]!)) {
            collisions.push(`${boxes[i]!.id} ∩ ${boxes[j]!.id}`);
          }
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('gives War 2+2 versus cards and no per-seat holes', () => {
    const layout = tableLayoutFor('war');
    expect(layout.playerCards).toHaveLength(0);
    expect(layout.dealerCards).toHaveLength(2);
    expect(layout.versusPlayerCards).toHaveLength(2);
  });

  it('places the blackjack dealer at the top with seven player seats', () => {
    const layout = tableLayoutFor('blackjack');
    expect(layout.seatCount).toBe(8);
    expect(layout.band(0)).toBe('top');
    expect(layout.avatars[0]!.cy).toBeLessThan(200);
    expect(layout.dealerCards.length).toBeGreaterThanOrEqual(2);
  });
});
