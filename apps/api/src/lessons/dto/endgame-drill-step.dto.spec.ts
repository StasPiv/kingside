/**
 * Unit-тесты `EndgameDrillStepPayloadDto` (KS-1815 / L-24).
 *
 * Покрытие по Gherkin:
 *   - валидный payload (все 4 варианта `winCondition`);
 *   - невалидный `fen`;
 *   - `skillLevel` -1 и 21;
 *   - `playerSide` не в enum;
 *   - `winCondition.kind='mate'` с лишним `fen` → ошибка;
 *   - `winCondition.kind='reach_position'` без `fen` → ошибка;
 *   - `winCondition.kind='material_advantage'` c `amount=0` → ошибка;
 *   - неверный `type`.
 */

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EndgameDrillStepPayloadDto } from './step-payload.dto';

// KP vs K эндшпиль — белая пешка на e2, белый король на e1, чёрный на e8.
const VALID_FEN = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
const VALID_FEN_TARGET = '4k3/8/8/8/4P3/8/8/4K3 b - - 0 2';

async function validatePayload(payload: unknown): Promise<string[]> {
  const instance = plainToInstance(EndgameDrillStepPayloadDto, payload);
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

describe('EndgameDrillStepPayloadDto (KS-1815)', () => {
  // ── Валидные варианты winCondition ───────────────────────────────

  it('валидный payload с winCondition.kind="mate" — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 5,
      winCondition: { kind: 'mate' },
    });
    expect(errors).toEqual([]);
  });

  it('валидный payload с winCondition.kind="promote" — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 10,
      winCondition: { kind: 'promote' },
    });
    expect(errors).toEqual([]);
  });

  it('валидный payload с winCondition.kind="reach_position" + fen — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 0,
      winCondition: { kind: 'reach_position', fen: VALID_FEN_TARGET },
    });
    expect(errors).toEqual([]);
  });

  it('валидный payload с winCondition.kind="material_advantage" amount=1 — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'black',
      skillLevel: 20,
      winCondition: { kind: 'material_advantage', amount: 1 },
    });
    expect(errors).toEqual([]);
  });

  it('валидный payload с maxMoves и hintsAllowed — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 8,
      winCondition: { kind: 'mate' },
      maxMoves: 40,
      hintsAllowed: true,
    });
    expect(errors).toEqual([]);
  });

  // ── Негативные кейсы ─────────────────────────────────────────────

  it('невалидный fen — ошибка на fen', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: 'garbage',
      playerSide: 'white',
      skillLevel: 5,
      winCondition: { kind: 'mate' },
    });
    expect(errors.some((m) => m.startsWith('fen:'))).toBe(true);
  });

  it('skillLevel = -1 → ошибка', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: -1,
      winCondition: { kind: 'mate' },
    });
    expect(errors.some((m) => m.startsWith('skillLevel:'))).toBe(true);
  });

  it('skillLevel = 21 → ошибка', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 21,
      winCondition: { kind: 'mate' },
    });
    expect(errors.some((m) => m.startsWith('skillLevel:'))).toBe(true);
  });

  it('skillLevel не целое (5.5) → ошибка', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 5.5,
      winCondition: { kind: 'mate' },
    });
    expect(errors.some((m) => m.startsWith('skillLevel:'))).toBe(true);
  });

  it('playerSide не в enum (red) → ошибка', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'red',
      skillLevel: 5,
      winCondition: { kind: 'mate' },
    });
    expect(errors.some((m) => m.startsWith('playerSide:'))).toBe(true);
  });

  it('winCondition.kind="mate" с лишним fen → ошибка', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 5,
      winCondition: { kind: 'mate', fen: VALID_FEN_TARGET },
    });
    expect(errors.some((m) => m.startsWith('winCondition:'))).toBe(true);
  });

  it('winCondition.kind="reach_position" без fen → ошибка', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 5,
      winCondition: { kind: 'reach_position' },
    });
    expect(errors.some((m) => m.startsWith('winCondition:'))).toBe(true);
  });

  it('winCondition.kind="reach_position" с битым fen → ошибка', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 5,
      winCondition: { kind: 'reach_position', fen: 'garbage' },
    });
    expect(errors.some((m) => m.startsWith('winCondition:'))).toBe(true);
  });

  it('winCondition.kind="material_advantage" c amount=0 → ошибка', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 5,
      winCondition: { kind: 'material_advantage', amount: 0 },
    });
    expect(errors.some((m) => m.startsWith('winCondition:'))).toBe(true);
  });

  it('winCondition.kind="material_advantage" без amount → ошибка', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 5,
      winCondition: { kind: 'material_advantage' },
    });
    expect(errors.some((m) => m.startsWith('winCondition:'))).toBe(true);
  });

  it('winCondition.kind неизвестен → ошибка', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 5,
      winCondition: { kind: 'something_else' },
    });
    expect(errors.some((m) => m.startsWith('winCondition:'))).toBe(true);
  });

  it('maxMoves = 0 → ошибка', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 5,
      winCondition: { kind: 'mate' },
      maxMoves: 0,
    });
    expect(errors.some((m) => m.startsWith('maxMoves:'))).toBe(true);
  });

  it('неверный type → ошибка', async () => {
    const errors = await validatePayload({
      type: 'video',
      fen: VALID_FEN,
      playerSide: 'white',
      skillLevel: 5,
      winCondition: { kind: 'mate' },
    });
    expect(errors.some((m) => m.startsWith('type:'))).toBe(true);
  });
});
