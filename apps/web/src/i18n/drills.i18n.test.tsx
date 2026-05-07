import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import i18n, { type i18n as I18nInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { ReactElement } from 'react';

import en from './locales/en/translation.json';
import ru from './locales/ru/translation.json';
import {
  DrillInstructions,
  DrillTypeCard,
} from '../components/drills';

/**
 * KS-2238 (ADR-035 §2.3, E3) — snapshot-тесты i18n-переводов для
 * drill-инструкций и названий drill-типов. Финализированные RU/EN
 * формулировки утверждены chess-expert в KS-2223 и оформлены архитектором
 * в `docs/architecture/tactical-drills-methodology.md` §3.
 *
 * Что покрываем:
 *  1. Все 8 drill-ID имеют ключи в `drills.instructions.<id>`,
 *     `drills.types.<id>`, `drills.typeDescriptions.<id>` (для обоих
 *     locale).
 *  2. Render-snapshot `<DrillInstructions>{t('drills.instructions.<id>')}</DrillInstructions>`
 *     и `<DrillTypeCard title={t(...types.<id>)} description={t(...typeDescriptions.<id>)} />`
 *     для каждого id × locale.
 *  3. Базовые UX-копи (`drills.buttons.*`, `drills.feedback.*`,
 *     `drills.errors.*`, `drills.lobby.*`, `drills.side.*`) сериализуются
 *     в snapshot целым объектом — регрессия любого ключа подсветится
 *     diff'ом.
 *
 * Если завтра расширим список drill-типов до 9 (v2), снимок
 * автоматически зафейлится, заставив осознанно обновить тест.
 */

const DRILL_IDS = [
  'findHangingPiece',
  'findLoosePiece',
  'findPin',
  'findFork',
  'countAttackers',
  'findAllChecks',
  'findUndefendedAttack',
] as const;

function makeI18n(lng: 'en' | 'ru'): I18nInstance {
  const inst = i18n.createInstance();
  inst.use(initReactI18next).init({
    resources: { en: { translation: en }, ru: { translation: ru } },
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
  return inst;
}

function renderWithLocale(ui: ReactElement, lng: 'en' | 'ru') {
  const inst = makeI18n(lng);
  return render(<I18nextProvider i18n={inst}>{ui}</I18nextProvider>);
}

function DrillI18nFixture() {
  const { t } = useTranslation();
  return (
    <div data-testid="drills-i18n-fixture">
      <h2>{t('drills.title')}</h2>
      <p>{t('drills.lobbyHeading')}</p>
      <p>{t('drills.lobbySubheading')}</p>
      {DRILL_IDS.map((id) => (
        <section key={id} data-drill-id={id}>
          <DrillInstructions>{t(`drills.instructions.${id}`)}</DrillInstructions>
          <DrillTypeCard
            title={t(`drills.types.${id}`)}
            description={t(`drills.typeDescriptions.${id}`)}
          />
        </section>
      ))}
    </div>
  );
}

describe('drills i18n — все ключи присутствуют в обоих locale', () => {
  it.each(DRILL_IDS)('en: ключи для drill="%s" не fallback на defaultValue', (id) => {
    expect(en.drills.instructions[id]).toBeTypeOf('string');
    expect(en.drills.instructions[id].length).toBeGreaterThan(0);
    expect(en.drills.types[id]).toBeTypeOf('string');
    expect(en.drills.typeDescriptions[id]).toBeTypeOf('string');
  });

  it.each(DRILL_IDS)('ru: ключи для drill="%s" не fallback на defaultValue', (id) => {
    expect(ru.drills.instructions[id]).toBeTypeOf('string');
    expect(ru.drills.instructions[id].length).toBeGreaterThan(0);
    expect(ru.drills.types[id]).toBeTypeOf('string');
    expect(ru.drills.typeDescriptions[id]).toBeTypeOf('string');
  });

  it('en и ru drills имеют идентичную структуру ключей', () => {
    // KS-2459: i18next-плюральные суффиксы (`_one`, `_few`, `_many`,
    // `_other`, `_zero`, `_two`) различаются между языками — RU имеет
    // `_few/_many`, EN — только `_one/_other`. Нормализуем, чтобы
    // сравнивать только базовые ключи.
    const PLURAL_SUFFIXES = /_(zero|one|two|few|many|other)$/;
    function shape(obj: unknown, path: string[] = []): string[] {
      if (obj == null || typeof obj !== 'object') return [path.join('.')];
      const out: string[] = [];
      for (const k of Object.keys(obj as Record<string, unknown>).sort()) {
        const normalized = k.replace(PLURAL_SUFFIXES, '');
        out.push(
          ...shape((obj as Record<string, unknown>)[k], [...path, normalized]),
        );
      }
      return out;
    }
    // `Set` снимает дубли после нормализации (`correct_one` и
    // `correct_other` оба превратятся в `correct`).
    const enShape = Array.from(new Set(shape(en.drills))).sort();
    const ruShape = Array.from(new Set(shape(ru.drills))).sort();
    expect(enShape).toEqual(ruShape);
  });
});

describe('drills i18n — render snapshots', () => {
  it('en: render-snapshot DrillInstructions + DrillTypeCard для всех 7 типов', () => {
    const { container } = renderWithLocale(<DrillI18nFixture />, 'en');
    expect(container.firstChild).toMatchSnapshot();
  });

  it('ru: render-snapshot DrillInstructions + DrillTypeCard для всех 7 типов', () => {
    const { container } = renderWithLocale(<DrillI18nFixture />, 'ru');
    expect(container.firstChild).toMatchSnapshot();
  });

  it('en: snapshot UX-копи (buttons/feedback/errors/lobby/side)', () => {
    expect({
      buttons: en.drills.buttons,
      feedback: en.drills.feedback,
      errors: en.drills.errors,
      lobby: en.drills.lobby,
      side: en.drills.side,
    }).toMatchSnapshot();
  });

  it('ru: snapshot UX-копи (buttons/feedback/errors/lobby/side)', () => {
    expect({
      buttons: ru.drills.buttons,
      feedback: ru.drills.feedback,
      errors: ru.drills.errors,
      lobby: ru.drills.lobby,
      side: ru.drills.side,
    }).toMatchSnapshot();
  });

  // KS-2459: drill-explanation формулировки + chess.pieces. Финализированные
  // тексты (RU/EN) утверждены chess-expert в KS-2454, использует
  // `DrillExplanationPanel` (KS-2457) и `explainDrill()` (KS-2456).
  it('en: snapshot drills.explanation + chess.pieces', () => {
    expect({
      explanation: en.drills.explanation,
      chessPieces: en.chess.pieces,
    }).toMatchSnapshot();
  });

  it('ru: snapshot drills.explanation + chess.pieces', () => {
    expect({
      explanation: ru.drills.explanation,
      chessPieces: ru.chess.pieces,
    }).toMatchSnapshot();
  });
});

// KS-2459: проверяем, что все ключи `drills.explanation.*`,
// используемые движком (KS-2456), реально существуют в обеих локалях
// и не являются fallback'ом на сам ключ.
describe('KS-2459 — drills.explanation все ключи присутствуют в обоих locale', () => {
  // Список ключей, которые движок может прислать в `DrillExplanationNote.key`.
  // Извлечён из byType-модулей (KS-2456) + методики chess-expert (KS-2454).
  const REQUIRED_KEYS = [
    'common.title',
    'common.yourAnswer',
    'common.correctAnswer',
    'common.next',
    'countAttackers.userAnswer',
    'countAttackers.list',
    'countDefenders.userAnswer',
    'countDefenders.list',
    'findLoosePiece.correct',
    'findLoosePiece.wrong',
    'findHangingPiece.correct',
    'findHangingPiece.correctUndefended',
    'findHangingPiece.wrong',
    'findAllChecks.missed',
    'findAllChecks.wrong',
    'findAllChecks.tagDirect',
    'findAllChecks.tagDiscovered',
    'findAllChecks.tagDouble',
    'findAllChecks.summaryGroup',
    'findPin.correctAbsolute',
    'findPin.correctRelative',
    'findPin.wrong',
    'findFork.correct',
    'findFork.correctWithCheck',
    'findFork.wrong',
    'findUndefendedAttack.correct',
    'findUndefendedAttack.correctMulti',
    'findUndefendedAttack.correctFreeWin',
    'findUndefendedAttack.wrong',
  ] as const;

  // i18next plural keys: для `*.correct_one/_other/_few/_many` — проверяем
  // отдельно, базовый ключ `correct` без суффикса не существует, но
  // движок передаёт `count` и i18next сам подставит вариант.
  const PLURAL_KEYS = [
    ['countAttackers.correct_one', 'countAttackers.correct_other'],
    ['countDefenders.correct_one', 'countDefenders.correct_other'],
    ['findAllChecks.correct_one', 'findAllChecks.correct_other'],
  ] as const;

  function getNested(obj: unknown, path: string): unknown {
    return path
      .split('.')
      .reduce<
        unknown
      >((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);
  }

  it.each(REQUIRED_KEYS)('en: drills.explanation.%s — строка', (path) => {
    const value = getNested(en.drills.explanation, path);
    expect(value).toBeTypeOf('string');
    expect(value).not.toBe('');
  });

  it.each(REQUIRED_KEYS)('ru: drills.explanation.%s — строка', (path) => {
    const value = getNested(ru.drills.explanation, path);
    expect(value).toBeTypeOf('string');
    expect(value).not.toBe('');
  });

  it.each(PLURAL_KEYS.flat())('en: plural-вариант drills.explanation.%s — строка', (path) => {
    const value = getNested(en.drills.explanation, path);
    expect(value).toBeTypeOf('string');
  });

  it.each(PLURAL_KEYS.flat())('ru: plural-вариант drills.explanation.%s — строка', (path) => {
    const value = getNested(ru.drills.explanation, path);
    expect(value).toBeTypeOf('string');
  });

  // RU должен иметь _few и _many для корректной CLDR-морфологии.
  it('ru: имеет _few и _many для плюральных ключей countAttackers/countDefenders/findAllChecks', () => {
    for (const base of ['countAttackers', 'countDefenders', 'findAllChecks']) {
      expect(getNested(ru.drills.explanation, `${base}.correct_few`)).toBeTypeOf('string');
      expect(getNested(ru.drills.explanation, `${base}.correct_many`)).toBeTypeOf('string');
    }
  });

  it('chess.pieces все 6 фигур присутствуют в обоих locale', () => {
    for (const t of ['p', 'n', 'b', 'r', 'q', 'k'] as const) {
      expect(en.chess.pieces[t]).toBeTypeOf('string');
      expect(ru.chess.pieces[t]).toBeTypeOf('string');
    }
  });
});
