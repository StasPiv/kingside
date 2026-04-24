/**
 * Unit-тесты `OpeningDrillStepPayloadDto` (KS-1816 / L-32).
 *
 * Покрытие по Gherkin:
 *   - валидные: основная линия без вариантов / с одним вариантом /
 *     с вложенными вариантами; playerSide=white и black;
 *     onDeviation='show_correction' (без engineSkillLevel) и
 *     onDeviation='engine_punish' с engineSkillLevel=5;
 *   - негативные: пустой PGN, битый PGN, неверный type, playerSide='red',
 *     onDeviation='punish', engineSkillLevel -1/21/3.5.
 */

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OpeningDrillStepPayloadDto } from './step-payload.dto';

// Главная линия: 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6
const PGN_MAIN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6';

// С одним вариантом: после 2. Nf3 — альтернатива 2. Nc3 Nc6.
const PGN_VARIATION = '1. e4 e5 2. Nf3 (2. Nc3 Nc6) Nc6 3. Bb5 a6';

// Вложенные варианты: внутри варианта после 2. Nc3 — суб-вариант 2... Nf6.
const PGN_NESTED = '1. e4 e5 2. Nf3 (2. Nc3 (2... Nf6) Nc6) Nc6';

async function validatePayload(payload: unknown): Promise<string[]> {
  const instance = plainToInstance(OpeningDrillStepPayloadDto, payload);
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

describe('OpeningDrillStepPayloadDto (KS-1816)', () => {
  // ── Валидные варианты ────────────────────────────────────────────

  it('валидный: основная линия без вариантов — ok', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_MAIN,
      playerSide: 'white',
      onDeviation: 'show_correction',
    });
    expect(errors).toEqual([]);
  });

  it('валидный: PGN с одним вариантом — ok', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_VARIATION,
      playerSide: 'white',
      onDeviation: 'engine_punish',
      engineSkillLevel: 10,
    });
    expect(errors).toEqual([]);
  });

  it('валидный: PGN с вложенными вариантами — ok', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_NESTED,
      playerSide: 'black',
      onDeviation: 'engine_punish',
      engineSkillLevel: 5,
    });
    expect(errors).toEqual([]);
  });

  it('валидный: playerSide=black — ok', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_MAIN,
      playerSide: 'black',
      onDeviation: 'show_correction',
    });
    expect(errors).toEqual([]);
  });

  it('валидный: show_correction без engineSkillLevel — ok', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_MAIN,
      playerSide: 'white',
      onDeviation: 'show_correction',
    });
    expect(errors).toEqual([]);
  });

  it('валидный: engine_punish с engineSkillLevel=0 — ok (нижняя граница)', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_MAIN,
      playerSide: 'white',
      onDeviation: 'engine_punish',
      engineSkillLevel: 0,
    });
    expect(errors).toEqual([]);
  });

  it('валидный: engine_punish с engineSkillLevel=20 — ok (верхняя граница)', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_MAIN,
      playerSide: 'white',
      onDeviation: 'engine_punish',
      engineSkillLevel: 20,
    });
    expect(errors).toEqual([]);
  });

  it('валидный: show_correction с engineSkillLevel тоже ok (нестрогая связка)', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_MAIN,
      playerSide: 'white',
      onDeviation: 'show_correction',
      engineSkillLevel: 8,
    });
    expect(errors).toEqual([]);
  });

  // ── Негативные ───────────────────────────────────────────────────

  it('пустой PGN → ошибка на pgn', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: '',
      playerSide: 'white',
      onDeviation: 'show_correction',
    });
    expect(errors.some((m) => m.startsWith('pgn:'))).toBe(true);
  });

  it('битый PGN (мусор) → ошибка на pgn', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: 'not-a-pgn',
      playerSide: 'white',
      onDeviation: 'show_correction',
    });
    expect(errors.some((m) => m.startsWith('pgn:'))).toBe(true);
  });

  it('PGN с несбалансированными скобками варианта → ошибка', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: '1. e4 (1. d4',
      playerSide: 'white',
      onDeviation: 'show_correction',
    });
    expect(errors.some((m) => m.startsWith('pgn:'))).toBe(true);
  });

  it('PGN только с тегами (без ходов) → ошибка', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: '[Event "x"]\n\n*',
      playerSide: 'white',
      onDeviation: 'show_correction',
    });
    expect(errors.some((m) => m.startsWith('pgn:'))).toBe(true);
  });

  it('неверный type → ошибка', async () => {
    const errors = await validatePayload({
      type: 'endgame_drill',
      pgn: PGN_MAIN,
      playerSide: 'white',
      onDeviation: 'show_correction',
    });
    expect(errors.some((m) => m.startsWith('type:'))).toBe(true);
  });

  it('playerSide=red → ошибка', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_MAIN,
      playerSide: 'red',
      onDeviation: 'show_correction',
    });
    expect(errors.some((m) => m.startsWith('playerSide:'))).toBe(true);
  });

  it('onDeviation=punish → ошибка', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_MAIN,
      playerSide: 'white',
      onDeviation: 'punish',
    });
    expect(errors.some((m) => m.startsWith('onDeviation:'))).toBe(true);
  });

  it('engineSkillLevel=-1 → ошибка', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_MAIN,
      playerSide: 'white',
      onDeviation: 'engine_punish',
      engineSkillLevel: -1,
    });
    expect(errors.some((m) => m.startsWith('engineSkillLevel:'))).toBe(true);
  });

  it('engineSkillLevel=21 → ошибка', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_MAIN,
      playerSide: 'white',
      onDeviation: 'engine_punish',
      engineSkillLevel: 21,
    });
    expect(errors.some((m) => m.startsWith('engineSkillLevel:'))).toBe(true);
  });

  it('engineSkillLevel=3.5 (не целое) → ошибка', async () => {
    const errors = await validatePayload({
      type: 'opening_drill',
      pgn: PGN_MAIN,
      playerSide: 'white',
      onDeviation: 'engine_punish',
      engineSkillLevel: 3.5,
    });
    expect(errors.some((m) => m.startsWith('engineSkillLevel:'))).toBe(true);
  });
});
