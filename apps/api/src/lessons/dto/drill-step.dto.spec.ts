/**
 * Unit-тесты `DrillStepPayloadDto` (KS-2249 / E6).
 *
 * Покрытие:
 *   - валидный минимальный payload (только type + drillType);
 *   - валидный с drillId (UUID);
 *   - валидный с difficultyBucket;
 *   - валидный с count + minSolved;
 *   - неизвестный drillType → ошибка;
 *   - не-UUID drillId → ошибка;
 *   - неверный bucket → ошибка;
 *   - count вне 1..10 → ошибка;
 *   - minSolved > count → ошибка;
 *   - неверный type → ошибка.
 *
 * Дополнительно — проверка `validateDrillStepPayload` (pure-функция) на тех
 * же кейсах, чтобы seed-линтер и DTO давали одинаковый словарь ошибок.
 */

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DrillStepPayloadDto } from './step-payload.dto';
import { validateDrillStepPayload } from './drill-step.validators';

const VALID_DRILL_ID = '7c4d2f02-1a3b-4d4e-9c4d-2a4e5b6c7d8e';

async function validateDto(payload: unknown): Promise<string[]> {
  const instance = plainToInstance(DrillStepPayloadDto, payload);
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

describe('DrillStepPayloadDto (KS-2249)', () => {
  // ── Позитивные ──────────────────────────────────────────────────

  it('минимальный валидный payload (type + drillType) — без ошибок', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-fork',
    });
    expect(errors).toEqual([]);
  });

  it('payload с drillId — без ошибок', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-pin',
      drillId: VALID_DRILL_ID,
    });
    expect(errors).toEqual([]);
  });

  it('payload с difficultyBucket — без ошибок', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'count-attackers',
      difficultyBucket: 'medium',
    });
    expect(errors).toEqual([]);
  });

  it('payload с count + minSolved (minSolved < count) — без ошибок', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-all-checks',
      count: 5,
      minSolved: 3,
    });
    expect(errors).toEqual([]);
  });

  it('payload с count == minSolved == 10 — без ошибок (граница)', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-undefended-attack',
      count: 10,
      minSolved: 10,
    });
    expect(errors).toEqual([]);
  });

  it('payload с drillId + difficultyBucket — без ошибок (bucket игнорируется backend)', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-fork',
      drillId: VALID_DRILL_ID,
      difficultyBucket: 'hard',
    });
    expect(errors).toEqual([]);
  });

  // ── Негативные ──────────────────────────────────────────────────

  it('неизвестный drillType → ошибка', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-something',
    });
    expect(errors.some((m) => m.startsWith('drillType:'))).toBe(true);
  });

  it('drillType не из 8 поддерживаемых (например, find-skewer) → ошибка', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-skewer',
    });
    expect(errors.some((m) => m.startsWith('drillType:'))).toBe(true);
  });

  it('drillId не UUID → ошибка', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-fork',
      drillId: 'not-a-uuid',
    });
    expect(errors.some((m) => m.startsWith('drillId:'))).toBe(true);
  });

  it('difficultyBucket не из enum (например, "easyish") → ошибка', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-fork',
      difficultyBucket: 'easyish',
    });
    expect(errors.some((m) => m.startsWith('difficultyBucket:'))).toBe(true);
  });

  it('count = 0 → ошибка', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-fork',
      count: 0,
    });
    expect(errors.some((m) => m.startsWith('count:'))).toBe(true);
  });

  it('count = 11 → ошибка', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-fork',
      count: 11,
    });
    expect(errors.some((m) => m.startsWith('count:'))).toBe(true);
  });

  it('count = 3.5 (не целое) → ошибка', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-fork',
      count: 3.5,
    });
    expect(errors.some((m) => m.startsWith('count:'))).toBe(true);
  });

  it('minSolved > count → ошибка через cross-field', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-fork',
      count: 3,
      minSolved: 5,
    });
    // cross-field валидатор висит на __crossField; ошибка должна
    // появиться (с упоминанием minSolved/count).
    expect(errors.length).toBeGreaterThan(0);
    const joined = errors.join(' ');
    expect(joined).toMatch(/minSolved/);
  });

  it('minSolved = 0 → ошибка', async () => {
    const errors = await validateDto({
      type: 'drill',
      drillType: 'find-fork',
      minSolved: 0,
    });
    expect(errors.some((m) => m.startsWith('minSolved:'))).toBe(true);
  });

  it('неверный type ("text") → ошибка', async () => {
    const errors = await validateDto({
      type: 'text',
      drillType: 'find-fork',
    });
    expect(errors.some((m) => m.startsWith('type:'))).toBe(true);
  });

  it('пропущен drillType → ошибка', async () => {
    const errors = await validateDto({
      type: 'drill',
    });
    expect(errors.some((m) => m.startsWith('drillType:'))).toBe(true);
  });
});

// ── Pure-функция (используется seed-линтером) ─────────────────────

describe('validateDrillStepPayload (pure, KS-2249)', () => {
  it('валидный payload — ok=true', () => {
    const res = validateDrillStepPayload({
      type: 'drill',
      drillType: 'find-fork',
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('count + minSolved cross-field: minSolved > count → ok=false', () => {
    const res = validateDrillStepPayload({
      type: 'drill',
      drillType: 'find-fork',
      count: 3,
      minSolved: 5,
    });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.path === 'minSolved')).toBe(true);
  });

  it('rootPath используется в путях ошибок', () => {
    const res = validateDrillStepPayload(
      { type: 'drill', drillType: 'unknown' },
      'step.payload',
    );
    expect(res.ok).toBe(false);
    expect(res.errors[0].path).toBe('step.payload.drillType');
  });

  it('drillId не UUID — путь "drillId" в errors', () => {
    const res = validateDrillStepPayload({
      type: 'drill',
      drillType: 'find-fork',
      drillId: 'bad-uuid',
    });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.path === 'drillId')).toBe(true);
  });
});
