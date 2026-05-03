/**
 * Unit-тесты `GameReviewStepPayloadDto` (KS-1811 / L-30).
 *
 * Покрытие по Gherkin:
 *   - только `gameId` — ok;
 *   - только `pgn` — ok;
 *   - оба заданы — ошибка (XOR);
 *   - ни одного — ошибка (XOR);
 *   - невалидный UUID в `gameId`;
 *   - невалидный PGN;
 *   - неверный `type`.
 */

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GameReviewStepPayloadDto } from './step-payload.dto';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6';

async function validatePayload(payload: unknown): Promise<string[]> {
  const instance = plainToInstance(GameReviewStepPayloadDto, payload);
  const errors = await validate(instance as object, {
    whitelist: true,
    forbidUnknownValues: false,
  });
  const out: string[] = [];
  for (const e of errors) {
    for (const msg of Object.values(e.constraints ?? {})) out.push(`${e.property}: ${msg}`);
  }
  return out;
}

describe('GameReviewStepPayloadDto', () => {
  it('только gameId (валидный UUID) — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      gameId: VALID_UUID,
    });
    expect(errors).toEqual([]);
  });

  it('только pgn (валидный) — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      pgn: VALID_PGN,
    });
    expect(errors).toEqual([]);
  });

  it('оба поля заданы — XOR-ошибка', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      gameId: VALID_UUID,
      pgn: VALID_PGN,
    });
    expect(errors.some((m) => m.startsWith('type:') && m.toLowerCase().includes('exactly one'))).toBe(
      true,
    );
  });

  it('ни одного поля — XOR-ошибка', async () => {
    const errors = await validatePayload({ type: 'game_review' });
    expect(errors.some((m) => m.startsWith('type:') && m.toLowerCase().includes('exactly one'))).toBe(
      true,
    );
  });

  it('оба поля пустые строки — XOR-ошибка', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      gameId: '',
      pgn: '',
    });
    expect(errors.some((m) => m.startsWith('type:') && m.toLowerCase().includes('exactly one'))).toBe(
      true,
    );
  });

  it('невалидный UUID — ошибка на gameId', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      gameId: 'not-a-uuid',
    });
    expect(errors.some((m) => m.startsWith('gameId:'))).toBe(true);
  });

  it('невалидный PGN — ошибка на pgn', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      pgn: 'not-a-pgn',
    });
    expect(errors.some((m) => m.startsWith('pgn:'))).toBe(true);
  });

  it('pgn без ходов (только теги) — ошибка на pgn', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      pgn: '[Event "x"]\n\n*',
    });
    expect(errors.some((m) => m.startsWith('pgn:'))).toBe(true);
  });

  it('неверный type — ошибка на type', async () => {
    const errors = await validatePayload({
      type: 'text',
      pgn: VALID_PGN,
    });
    expect(errors.some((m) => m.startsWith('type:'))).toBe(true);
  });

  it('PGN с тегами + валидными ходами — ok', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      pgn: '[Event "Test"]\n[Site "?"]\n\n1. d4 Nf6 2. c4 e6 *',
    });
    expect(errors).toEqual([]);
  });

  // ── KS-2280 (ADR-037 R6): NAG-аннотации и комментарии ────────────
  // PGN-стандарт допускает оба порядка `<move> $N {comment}` и
  // `<move> {comment} $N`. chess.js#loadPgn принимает только первый;
  // второй приводим к первому через `normalizeNagOrder` в валидаторе.

  it('KS-2280: PGN с NAG-токеном после хода — ok', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      pgn: '1. e4 $1 e5 *',
    });
    expect(errors).toEqual([]);
  });

  it('KS-2280: reverse-order `{comment} $N` принимается (нормализация)', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      pgn: '1. e4 {good!} $1 e5 *',
    });
    expect(errors).toEqual([]);
  });

  it('KS-2280: forward-order `$N {comment}` принимается', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      pgn: '1. e4 $1 {good!} e5 *',
    });
    expect(errors).toEqual([]);
  });

  it('KS-2280: несколько NAG до комментария — ok', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      pgn: '1. e4 $1 $14 {white slightly better} e5 *',
    });
    expect(errors).toEqual([]);
  });

  it('KS-2280: несколько NAG после комментария — ok (reverse-order)', async () => {
    const errors = await validatePayload({
      type: 'game_review',
      pgn: '1. e4 {white slightly better} $1 $14 e5 *',
    });
    expect(errors).toEqual([]);
  });
});
