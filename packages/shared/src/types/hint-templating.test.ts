/**
 * KS-4825 / ADR-154. Тесты `applyTemplate` + `parseTemplateVars` +
 * `getTriggerVars` + `TRIGGER_VAR_WHITELIST`.
 */
import { describe, it, expect } from 'vitest';
import type { HintShowPayload } from './hint-payload.js';
import {
  applyTemplate,
  getTriggerVars,
  HINT_TEMPLATE_PLACEHOLDER_RE,
  parseTemplateVars,
  TRIGGER_VAR_WHITELIST,
} from './hint-templating.js';

function mkPayload(over: Partial<HintShowPayload> = {}): HintShowPayload {
  return {
    hintId: 'h-1',
    key: 'analyze-after-loss',
    locale: 'ru',
    title: 'T',
    body: 'B',
    ctaLabel: null,
    instructionBody: null,
    ctaHref: null,
    ctaEvent: null,
    anchor: 'game-end-analysis-button',
    placement: 'top',
    ttlSec: 30,
    ...over,
  };
}

describe('HINT_TEMPLATE_PLACEHOLDER_RE', () => {
  it('матчит `{{name}}` с алфавитом [a-z][a-z0-9_]', () => {
    HINT_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
    const m = HINT_TEMPLATE_PLACEHOLDER_RE.exec('aaa {{game_id}} bbb {{x_1}} c');
    expect(m?.[1]).toBe('game_id');
  });

  it('не матчит UPPER / начинающееся с цифры / спецсимволов', () => {
    HINT_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
    expect(HINT_TEMPLATE_PLACEHOLDER_RE.test('{{Game_id}}')).toBe(false);
    HINT_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
    expect(HINT_TEMPLATE_PLACEHOLDER_RE.test('{{1game}}')).toBe(false);
    HINT_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
    expect(HINT_TEMPLATE_PLACEHOLDER_RE.test('{{game-id}}')).toBe(false);
  });
});

describe('parseTemplateVars', () => {
  it('возвращает уникальные имена', () => {
    expect(parseTemplateVars('/{{a}}/{{b}}/{{a}}')).toEqual(['a', 'b']);
  });

  it('null/undefined/без плейсхолдеров → []', () => {
    expect(parseTemplateVars(null)).toEqual([]);
    expect(parseTemplateVars(undefined)).toEqual([]);
    expect(parseTemplateVars('plain text')).toEqual([]);
  });
});

describe('getTriggerVars + TRIGGER_VAR_WHITELIST', () => {
  it('game_end содержит game_id/result/time_control/rating_delta', () => {
    const names = getTriggerVars('game_end').map((v) => v.name).sort();
    expect(names).toEqual(['game_id', 'rating_delta', 'result', 'time_control']);
  });

  it('неизвестный trigger → []', () => {
    expect(getTriggerVars('this_does_not_exist')).toEqual([]);
  });

  it('гостевые/системные триггеры — пустой массив', () => {
    expect(getTriggerVars('guest_landing_viewed')).toEqual([]);
    expect(getTriggerVars('page_view')).toEqual([]);
    expect(getTriggerVars('session_idle')).toEqual([]);
  });

  it('whitelist не содержит дублей имён в рамках одного триггера', () => {
    for (const [trigger, vars] of Object.entries(TRIGGER_VAR_WHITELIST)) {
      const names = vars.map((v) => v.name);
      const unique = new Set(names);
      expect(unique.size, trigger).toBe(names.length);
    }
  });
});

describe('applyTemplate — happy path', () => {
  it('ctaHref `/game/{{game_id}}/review` + game_end{game_id:"abc-1"} → подстановка + encodeURIComponent', () => {
    const out = applyTemplate(
      mkPayload({ ctaHref: '/game/{{game_id}}/review', ctaLabel: 'Открыть' }),
      { triggerEventType: 'game_end', triggerEventPayload: { game_id: 'abc-1' } },
    );
    expect(out.ctaHref).toBe('/game/abc-1/review');
    expect(out.ctaLabel).toBe('Открыть');
  });

  it('encodeURIComponent для значений с спецсимволами', () => {
    const out = applyTemplate(
      mkPayload({ ctaHref: '/x/{{theme}}/y' }),
      { triggerEventType: 'puzzle_failed', triggerEventPayload: { theme: 'knight + queen' } },
    );
    expect(out.ctaHref).toBe('/x/knight%20%2B%20queen/y');
  });

  it('ctaLabel `Партия {{time_control}}` + time_control="3+2"', () => {
    const out = applyTemplate(
      mkPayload({ ctaLabel: 'Партия {{time_control}}', ctaHref: '/game/{{game_id}}/review' }),
      { triggerEventType: 'game_end', triggerEventPayload: { game_id: 'g', time_control: '3+2' } },
    );
    expect(out.ctaLabel).toBe('Партия 3+2');
    expect(out.ctaHref).toBe('/game/g/review');
  });

  it('instructionBody `Игра {{game_id}}, {{rating_delta}}` → подставлено', () => {
    const out = applyTemplate(
      mkPayload({ instructionBody: 'Игра {{game_id}}, дельта {{rating_delta}}' }),
      { triggerEventType: 'game_end', triggerEventPayload: { game_id: 'gid', rating_delta: -8 } },
    );
    expect(out.instructionBody).toBe('Игра gid, дельта -8');
  });

  it('строки без плейсхолдеров проходят как есть', () => {
    const out = applyTemplate(
      mkPayload({ ctaHref: '/static', ctaLabel: 'Открыть', instructionBody: 'Просто текст' }),
      { triggerEventType: 'game_end', triggerEventPayload: { game_id: 'x' } },
    );
    expect(out.ctaHref).toBe('/static');
    expect(out.ctaLabel).toBe('Открыть');
    expect(out.instructionBody).toBe('Просто текст');
  });

  it('title/body/anchor/ctaEvent НЕ шаблонизируются', () => {
    const out = applyTemplate(
      mkPayload({ title: '{{game_id}}', body: '{{game_id}}', anchor: '{{x}}' as any, ctaEvent: '{{x}}' }),
      { triggerEventType: 'game_end', triggerEventPayload: { game_id: 'g' } },
    );
    expect(out.title).toBe('{{game_id}}');
    expect(out.body).toBe('{{game_id}}');
    expect(out.anchor).toBe('{{x}}');
    expect(out.ctaEvent).toBe('{{x}}');
  });
});

describe('applyTemplate — нерезолвенные плейсхолдеры', () => {
  it('ctaHref без fallback → null + ctaLabel принудительно null', () => {
    const out = applyTemplate(
      mkPayload({ ctaHref: '/game/{{game_id}}/review', ctaLabel: 'Открыть' }),
      { triggerEventType: 'game_end', triggerEventPayload: {} },
    );
    expect(out.ctaHref).toBeNull();
    expect(out.ctaLabel).toBeNull();
  });

  it('ctaHref с fallbackHref → fallback используется, ctaLabel сохраняется', () => {
    const out = applyTemplate(
      mkPayload({ ctaHref: '/game/{{game_id}}/review', ctaLabel: 'К партии' }),
      { triggerEventType: 'game_end', triggerEventPayload: {} },
      '/profile',
    );
    expect(out.ctaHref).toBe('/profile');
    expect(out.ctaLabel).toBe('К партии');
  });

  it('var вне whitelist (`{{user_email}}` на game_end) → не разрешён, ctaHref=null', () => {
    const out = applyTemplate(
      mkPayload({ ctaHref: '/{{user_email}}' }),
      { triggerEventType: 'game_end', triggerEventPayload: { user_email: 'a@b' } },
    );
    expect(out.ctaHref).toBeNull();
  });

  it('triggerEventPayload отсутствует → все vars не резолвятся', () => {
    const out = applyTemplate(
      mkPayload({ ctaHref: '/{{game_id}}', ctaLabel: 'Х', instructionBody: '{{game_id}}' }),
      { triggerEventType: 'game_end', triggerEventPayload: undefined },
    );
    expect(out.ctaHref).toBeNull();
    expect(out.ctaLabel).toBeNull();
    expect(out.instructionBody).toBeNull();
  });

  it('triggerEventType отсутствует → whitelist пустой, всё null', () => {
    const out = applyTemplate(
      mkPayload({ ctaHref: '/{{game_id}}', ctaLabel: 'X' }),
      { triggerEventType: undefined, triggerEventPayload: { game_id: 'g' } },
    );
    expect(out.ctaHref).toBeNull();
    expect(out.ctaLabel).toBeNull();
  });

  it('ctaLabel `Партия {{time_control}}` + payload пуст → "Партия" (placeholder вырезан, trim)', () => {
    const out = applyTemplate(
      mkPayload({ ctaLabel: 'Партия {{time_control}}', ctaHref: '/static' }),
      { triggerEventType: 'game_end', triggerEventPayload: {} },
    );
    expect(out.ctaLabel).toBe('Партия');
  });

  it('ctaLabel содержит ТОЛЬКО плейсхолдер → итог пустой → null', () => {
    const out = applyTemplate(
      mkPayload({ ctaLabel: '{{time_control}}', ctaHref: '/static' }),
      { triggerEventType: 'game_end', triggerEventPayload: {} },
    );
    expect(out.ctaLabel).toBeNull();
  });

  it('instructionBody содержит ТОЛЬКО плейсхолдер → null', () => {
    const out = applyTemplate(
      mkPayload({ instructionBody: '{{game_id}}' }),
      { triggerEventType: 'game_end', triggerEventPayload: {} },
    );
    expect(out.instructionBody).toBeNull();
  });
});

describe('applyTemplate — coercion типов', () => {
  it('number → строка через String()', () => {
    const out = applyTemplate(
      mkPayload({ ctaHref: '/r/{{rating_delta}}' }),
      { triggerEventType: 'game_end', triggerEventPayload: { rating_delta: -8 } },
    );
    expect(out.ctaHref).toBe('/r/-8');
  });

  it('false / 0 валидны и подставляются (не считаются «отсутствующими»)', () => {
    const out = applyTemplate(
      mkPayload({ instructionBody: 'delta={{rating_delta}}' }),
      { triggerEventType: 'game_end', triggerEventPayload: { rating_delta: 0 } },
    );
    expect(out.instructionBody).toBe('delta=0');
  });

  it('null → нерезолвенная (плейсхолдер удаляется, ctaHref → fallback)', () => {
    const out = applyTemplate(
      mkPayload({ ctaHref: '/g/{{game_id}}', ctaLabel: 'L' }),
      { triggerEventType: 'game_end', triggerEventPayload: { game_id: null } },
      '/profile',
    );
    expect(out.ctaHref).toBe('/profile');
  });
});
