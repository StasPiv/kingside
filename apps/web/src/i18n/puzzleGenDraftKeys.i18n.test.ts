import { describe, it, expect } from 'vitest';

import en from './locales/en/translation.json';
import ru from './locales/ru/translation.json';

/**
 * KS-2587 (ADR-050 §3 #8). Snapshot-проверка наличия и парности ключей
 * i18n для нового client-side puzzle-генератора (KS-2584/2585) и
 * draft/publish-flow (KS-2586).
 *
 * Принцип такой же как в `quizDiagramKeys.i18n.test.ts` (KS-2575): ключи
 * — контракт между UI и переводами; снапшот-тест ловит ошибки удаления
 * или опечатки до того как пользователь увидит fallback-литерал
 * `puzzleGenerator.savedAsDrafts` вместо реального текста.
 */

const REQUIRED_KEYS: ReadonlyArray<string> = [
  // Параметры генератора (KS-2585)
  'puzzleGenerator.blunderDelta',
  'puzzleGenerator.blunderDeltaValue',
  'puzzleGenerator.blunderDeltaHint',
  'puzzleGenerator.solvabilityCheck',
  'puzzleGenerator.solvabilityCheckHint',

  // Draft / Publish flow в модалке генератора (KS-2585/2586)
  'puzzleGenerator.savedAsDrafts',
  'puzzleGenerator.draftsExplanation',
  'puzzleGenerator.myDrafts',
  'puzzleGenerator.publishAll',
  'puzzleGenerator.publishOne',
  'puzzleGenerator.publishedToast',

  // Badges и фильтры в puzzleBrowser (KS-2586)
  'puzzleBrowser.draftBadge',
  'puzzleBrowser.visibilityFilter.draft',
  'puzzleBrowser.visibilityFilter.public',
  'puzzleBrowser.visibilityFilter.all',
];

/**
 * KS-2587: legacy-ключи, которые должны быть УДАЛЕНЫ из JSON после
 * KS-2585 (CP-эра генератора и старые «Solve now / My puzzles» в модалке).
 * Тест ловит регрессию, если кто-то случайно вернёт их.
 */
const FORBIDDEN_PUZZLE_GENERATOR_KEYS: ReadonlyArray<string> = [
  'gapThreshold',
  'maxSecond',
  'minGap',
  'lines',
  'acceptedMoves',
  'acceptedMovesHint',
  'skipHanging',
  'skipHangingHint',
  'skipAttacked',
  'skipAttackedHint',
  'skipUndefended',
  'skipUndefendedHint',
  'solveNow',
  'myPuzzles',
];

function lookup(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      obj,
    );
}

describe('KS-2587: i18n keys for puzzle generator + draft/publish flow', () => {
  for (const key of REQUIRED_KEYS) {
    it(`en содержит "${key}"`, () => {
      const v = lookup(en, key);
      expect(typeof v).toBe('string');
      expect((v as string).length).toBeGreaterThan(0);
    });

    it(`ru содержит "${key}"`, () => {
      const v = lookup(ru, key);
      expect(typeof v).toBe('string');
      expect((v as string).length).toBeGreaterThan(0);
    });
  }

  it('en и ru — значения не совпадают с ключом (защита от опечаток)', () => {
    for (const key of REQUIRED_KEYS) {
      expect(lookup(en, key), `en[${key}]`).not.toBe(key);
      expect(lookup(ru, key), `ru[${key}]`).not.toBe(key);
    }
  });

  it('legacy-ключи генератора удалены из en.puzzleGenerator', () => {
    const block = (en as { puzzleGenerator: Record<string, unknown> })
      .puzzleGenerator;
    for (const k of FORBIDDEN_PUZZLE_GENERATOR_KEYS) {
      expect(k in block, `en.puzzleGenerator.${k} must be removed`).toBe(false);
    }
  });

  it('legacy-ключи генератора удалены из ru.puzzleGenerator', () => {
    const block = (ru as { puzzleGenerator: Record<string, unknown> })
      .puzzleGenerator;
    for (const k of FORBIDDEN_PUZZLE_GENERATOR_KEYS) {
      expect(k in block, `ru.puzzleGenerator.${k} must be removed`).toBe(false);
    }
  });

  it('publishAll EN текст содержит «Precision Training»', () => {
    const v = lookup(en, 'puzzleGenerator.publishAll') as string;
    expect(v).toMatch(/Precision Training/);
  });

  it('publishAll RU текст содержит «Тренировку точности»', () => {
    const v = lookup(ru, 'puzzleGenerator.publishAll') as string;
    expect(v).toMatch(/Тренировку точности/);
  });

  it('blunderDeltaValue содержит {{percent}} плейсхолдер', () => {
    expect(lookup(en, 'puzzleGenerator.blunderDeltaValue')).toMatch(
      /\{\{percent\}\}/,
    );
    expect(lookup(ru, 'puzzleGenerator.blunderDeltaValue')).toMatch(
      /\{\{percent\}\}/,
    );
  });

  it('savedAsDrafts содержит {{count}} плейсхолдер', () => {
    expect(lookup(en, 'puzzleGenerator.savedAsDrafts')).toMatch(
      /\{\{count\}\}/,
    );
    expect(lookup(ru, 'puzzleGenerator.savedAsDrafts')).toMatch(
      /\{\{count\}\}/,
    );
  });
});
