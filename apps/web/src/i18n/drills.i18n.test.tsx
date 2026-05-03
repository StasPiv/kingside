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
  'findMateInOneSquare',
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
    function shape(obj: unknown, path: string[] = []): string[] {
      if (obj == null || typeof obj !== 'object') return [path.join('.')];
      const out: string[] = [];
      for (const k of Object.keys(obj as Record<string, unknown>).sort()) {
        out.push(
          ...shape((obj as Record<string, unknown>)[k], [...path, k]),
        );
      }
      return out;
    }
    expect(shape(en.drills)).toEqual(shape(ru.drills));
  });
});

describe('drills i18n — render snapshots', () => {
  it('en: render-snapshot DrillInstructions + DrillTypeCard для всех 8 типов', () => {
    const { container } = renderWithLocale(<DrillI18nFixture />, 'en');
    expect(container.firstChild).toMatchSnapshot();
  });

  it('ru: render-snapshot DrillInstructions + DrillTypeCard для всех 8 типов', () => {
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
});
