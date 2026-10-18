import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, CursorAgentError } from '@cursor/sdk';
import { expect, type Page, type TestInfo } from '@playwright/test';
import type { GameSnapshot } from './game-api';
import {
  buildExpectedCardLayout,
  formatExpectedLayout,
  type ExpectedCardLayout,
} from './card-verification';
import { cardRankSuitLabel } from './card-encoding';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const VISION_MODEL = process.env.POKER_E2E_VISION_MODEL ?? 'composer-2.5';

export type VisionVerification = {
  ok: boolean;
  model: string;
  board?: string[];
  holes?: Record<string, string[]>;
  mismatches?: string[];
  reasoning?: string;
  raw?: string;
  error?: string;
};

function cursorApiKey(): string {
  const key = process.env.CURSOR_API_KEY;
  if (!key) {
    throw new Error(
      'CURSOR_API_KEY is required for vision card verification. '
      + 'Create a key at https://cursor.com/dashboard/integrations and export it before running E2E tests.',
    );
  }
  return key;
}

function normalizeVisionLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^ace\b/, 'a')
    .replace(/^king\b/, 'k')
    .replace(/^queen\b/, 'q')
    .replace(/^jack\b/, 'j')
    .replace(/\bface down\b/, 'face-down')
    .replace(/\bface-down\b/, 'face-down');
}

function cardShortLabelFromLabel(label: string): string | null {
  const normalized = normalizeVisionLabel(label);
  if (normalized === 'face-down') {
    return 'down';
  }
  const match = normalized.match(/^([2-9tjqka]|10)\s+of\s+(spades|hearts|diamonds|clubs)$/);
  if (!match) {
    return null;
  }
  const rank = match[1]!.toUpperCase();
  const suitChar = { spades: 'S', hearts: 'H', diamonds: 'D', clubs: 'C' }[match[2]!]!;
  return `${rank}${suitChar}`;
}

function labelsMatch(seen: string, expected: string): boolean {
  const a = normalizeVisionLabel(seen);
  const b = normalizeVisionLabel(expected);
  if (a === b) {
    return true;
  }
  const shortExpected = cardShortLabelFromLabel(expected);
  const shortSeen = cardShortLabelFromLabel(seen);
  return Boolean(shortExpected && shortSeen && shortExpected === shortSeen);
}

function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();
  return JSON.parse(body) as Record<string, unknown>;
}

export function formatExpectedLayoutForVision(
  state: GameSnapshot,
  viewerSeat: number | null,
): string {
  const layout = buildExpectedCardLayout(state, viewerSeat);
  const board = layout.shared
    .map((slot, index) => `board[${index}]: ${cardRankSuitLabel(slot.unicode)}`)
    .join('\n');
  const holes = Object.entries(layout.holes)
    .map(([seat, cards]) => {
      const rendered = cards
        .map((slot, index) => `hole[${index}]: ${cardRankSuitLabel(slot.unicode)}`)
        .join(', ');
      return `seat ${seat}: ${rendered}`;
    })
    .join('\n');
  return [
    `phase: ${state.phase}`,
    `viewer seat: ${viewerSeat ?? 'observer (not seated)'}`,
    'board (left to right, 5 slots):',
    board,
    'hole cards:',
    holes || '(none seated)',
  ].join('\n');
}

function buildVerificationPrompt(
  expectedLayout: ExpectedCardLayout,
  context: { phase: string; viewerSeat: number | null },
): string {
  const expectedBoard = expectedLayout.shared.map((slot) => cardRankSuitLabel(slot.unicode));
  const expectedHoles: Record<string, string[]> = {};
  for (const [seat, cards] of Object.entries(expectedLayout.holes)) {
    expectedHoles[seat] = cards.map((slot) => cardRankSuitLabel(slot.unicode));
  }

  return [
    'You are verifying a poker table screenshot from an automated E2E test.',
    'Do not use tools, run commands, or edit files. Only inspect the attached image and reply.',
    '',
    `Game phase: ${context.phase}`,
    `Viewer seat: ${context.viewerSeat ?? 'observer (not seated)'}`,
    '',
    'EXPECTED cards (ground truth from the game server):',
    `Board (5 slots, left to right): ${JSON.stringify(expectedBoard)}`,
    `Hole cards by seat: ${JSON.stringify(expectedHoles)}`,
    '',
    'Instructions:',
    '- Look at the screenshot carefully.',
    '- Cards show as Unicode playing-card glyphs on a green felt table.',
    '- Face-down cards show a patterned card back (not rank/suit).',
    '- Face-up cards show rank and suit on the glyph.',
    '- Board cards are in the center row; hole cards are near each player seat.',
    '- Compare what you SEE to the EXPECTED list above.',
    '',
    'Reply with JSON only (no markdown prose):',
    '{',
    '  "match": boolean,',
    '  "board": ["label for slot 0", "...", "...", "...", "..."],',
    '  "holes": { "0": ["left hole", "right hole"], ... },',
    '  "mismatches": ["human-readable mismatch descriptions"],',
    '  "reasoning": "brief explanation"',
    '}',
    '',
    'Use labels like "face-down", "2 of hearts", "Ace of spades", "King of clubs".',
    'Set match=true only if every expected board slot and hole card matches what is visible.',
    'For face-down expected cards, the screenshot must show a card back, not a rank/suit.',
  ].join('\n');
}

async function askCursorVision(
  pngBuffer: Buffer,
  prompt: string,
): Promise<string> {
  const agent = await Agent.create({
    apiKey: cursorApiKey(),
    model: { id: VISION_MODEL },
    local: {
      cwd: REPO_ROOT,
      settingSources: [],
    },
  });

  try {
    const run = await agent.send({
      text: prompt,
      images: [{ data: pngBuffer.toString('base64'), mimeType: 'image/png' }],
    });
    const result = await run.wait();
    if (result.status !== 'finished') {
      throw new Error(`Cursor vision run ended with status ${result.status}`);
    }
    return result.result ?? '';
  } catch (error) {
    if (error instanceof CursorAgentError) {
      throw new Error(`Cursor vision failed to start: ${error.message}`);
    }
    throw error;
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

export async function analyzeTableScreenshotWithVision(
  pngBuffer: Buffer,
  expectedLayout: ExpectedCardLayout,
  context: { phase: string; viewerSeat: number | null },
): Promise<VisionVerification> {
  const prompt = buildVerificationPrompt(expectedLayout, context);

  try {
    const rawText = await askCursorVision(pngBuffer, prompt);
    const parsed = extractJson(rawText);
    const board = Array.isArray(parsed.board)
      ? parsed.board.map(String)
      : undefined;
    const holes = parsed.holes && typeof parsed.holes === 'object' && !Array.isArray(parsed.holes)
      ? Object.fromEntries(
          Object.entries(parsed.holes as Record<string, unknown>).map(([seat, cards]) => [
            seat,
            Array.isArray(cards) ? cards.map(String) : [],
          ]),
        )
      : undefined;
    const mismatches: string[] = Array.isArray(parsed.mismatches)
      ? parsed.mismatches.map(String)
      : [];
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined;

    const expectedBoard = expectedLayout.shared.map((slot) => cardRankSuitLabel(slot.unicode));
    const expectedHoles: Record<string, string[]> = {};
    for (const [seat, cards] of Object.entries(expectedLayout.holes)) {
      expectedHoles[seat] = cards.map((slot) => cardRankSuitLabel(slot.unicode));
    }

    if (board) {
      for (let index = 0; index < expectedBoard.length; index += 1) {
        const seen = board[index];
        const expected = expectedBoard[index]!;
        if (!seen || !labelsMatch(seen, expected)) {
          mismatches.push(`board[${index}]: expected "${expected}", saw "${seen ?? 'missing'}"`);
        }
      }
    } else {
      mismatches.push('board: model did not return board array');
    }

    for (const [seat, expectedCards] of Object.entries(expectedHoles)) {
      const seen = holes?.[seat];
      if (!seen || seen.length !== expectedCards.length) {
        mismatches.push(`seat ${seat} holes: expected ${JSON.stringify(expectedCards)}, saw ${JSON.stringify(seen ?? null)}`);
        continue;
      }
      for (let index = 0; index < expectedCards.length; index += 1) {
        if (!labelsMatch(seen[index]!, expectedCards[index]!)) {
          mismatches.push(
            `seat ${seat} hole[${index}]: expected "${expectedCards[index]}", saw "${seen[index]}"`,
          );
        }
      }
    }

    const ok = parsed.match === true && mismatches.length === 0;

    return {
      ok,
      model: VISION_MODEL,
      board,
      holes,
      mismatches,
      reasoning,
      raw: rawText,
    };
  } catch (error) {
    return {
      ok: false,
      model: VISION_MODEL,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function assertCardsMatchVision(
  page: Page,
  state: GameSnapshot,
  viewerSeat: number | null,
  testInfo?: TestInfo,
  label?: string,
): Promise<void> {
  if (!process.env.CURSOR_API_KEY) {
    if (testInfo) {
      await testInfo.attach(`${label ?? state.phase}-vision-skipped`, {
        body: 'CURSOR_API_KEY unset — skipped Cursor vision card check',
        contentType: 'text/plain',
      });
    }
    return;
  }

  const expected = buildExpectedCardLayout(state, viewerSeat);
  const prefix = label ?? state.phase;

  const table = page.getByTestId('poker-table');
  await table.scrollIntoViewIfNeeded();
  const tableShot = await table.screenshot();

  if (testInfo) {
    await testInfo.attach(`${prefix}-table-vision.png`, { body: tableShot, contentType: 'image/png' });
  }

  const vision = await analyzeTableScreenshotWithVision(tableShot, expected, {
    phase: state.phase,
    viewerSeat,
  });

  const report = [
    `model: cursor/${vision.model}`,
    `expected:\n${formatExpectedLayoutForVision(state, viewerSeat)}`,
    `server snapshot: ${formatExpectedLayout(state, viewerSeat)}`,
    vision.reasoning ? `reasoning: ${vision.reasoning}` : '',
    vision.board ? `seen board: ${JSON.stringify(vision.board)}` : '',
    vision.holes ? `seen holes: ${JSON.stringify(vision.holes)}` : '',
    vision.mismatches?.length ? `mismatches:\n- ${vision.mismatches.join('\n- ')}` : '',
    vision.error ? `error: ${vision.error}` : '',
    vision.raw ? `raw: ${vision.raw}` : '',
  ].filter(Boolean).join('\n\n');

  if (testInfo) {
    await testInfo.attach(`${prefix}-vision-report`, {
      body: report,
      contentType: 'text/plain',
    });
  }

  expect(vision.ok, `Cursor vision verification failed for ${prefix}:\n${report}`).toBe(true);
}

export { formatExpectedLayoutForVision as formatVisionContext };
