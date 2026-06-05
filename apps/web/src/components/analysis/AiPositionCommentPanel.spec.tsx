/**
 * KS-3680. Тесты `AiPositionCommentPanel` — рендер всех 8 состояний,
 * disabled-режим для гостя, лейбл «Из полного разбора» и переключение
 * кнопки на «Перегенерировать».
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { AiPositionCommentPanel } from './AiPositionCommentPanel';
import type {
  AiCommentState,
  UseAiPositionCommentResult,
} from '../../hooks/useAiPositionComment';
import { SOFT_LIMIT, SOFT_WINDOW_MIN } from '../../hooks/useAiPositionComment';

// Минимальный i18n-мок: возвращаем defaultValue (`t(key, default)`) либо
// сам ключ, чтобы не подключать настоящий i18next к unit-тестам.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      defaultOrOpts?: string | Record<string, unknown>,
      maybeOpts?: Record<string, unknown>,
    ) => {
      const defaultValue =
        typeof defaultOrOpts === 'string' ? defaultOrOpts : key;
      const opts =
        typeof defaultOrOpts === 'object' ? defaultOrOpts : maybeOpts;
      if (opts) {
        return defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
          String(opts[name] ?? ''),
        );
      }
      return defaultValue;
    },
  }),
}));

function controllerOf(
  state: AiCommentState,
  overrides: Partial<UseAiPositionCommentResult> = {},
): UseAiPositionCommentResult {
  return {
    state,
    request: vi.fn(),
    regenerate: vi.fn(),
    softCounter: { used: 0, limit: SOFT_LIMIT, windowMin: SOFT_WINDOW_MIN },
    // KS-3691: дефолт — overlay отсутствует, чтобы тесты по умолчанию
    // продолжали работать как раньше.
    overlay: null,
    overlayHidden: false,
    toggleOverlay: vi.fn(),
    ...overrides,
  };
}

function renderPanel(controller: UseAiPositionCommentResult) {
  return render(
    <MemoryRouter>
      <AiPositionCommentPanel
        controller={controller}
        testIdSuffix="desktop"
      />
    </MemoryRouter>,
  );
}

const T_BTN = 'ai-position-comment-desktop-btn';

describe('AiPositionCommentPanel — рендер 8 состояний', () => {
  it('idle: активная кнопка с CTA, без текста', () => {
    renderPanel(controllerOf({ kind: 'idle' }));
    const btn = screen.getByTestId(T_BTN);
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent('Get AI evaluation');
    expect(screen.queryByTestId('ai-position-comment-desktop-text')).toBeNull();
  });

  it('loading: кнопка disabled, лейбл Loading…', () => {
    renderPanel(controllerOf({ kind: 'loading' }));
    const btn = screen.getByTestId(T_BTN);
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Loading…');
  });

  it('success(live): показывает текст из state.comment', () => {
    renderPanel(
      controllerOf({
        kind: 'success',
        comment: 'хорошая структура',
        source: 'live',
        highlights: [],
        arrows: [],
      }),
    );
    expect(screen.getByTestId('ai-position-comment-desktop-text')).toHaveTextContent(
      'хорошая структура',
    );
    expect(
      screen.queryByTestId('ai-position-comment-desktop-source-label'),
    ).toBeNull();
  });

  it('success(full-review): лейбл «From full review» + кнопка «Regenerate»', () => {
    renderPanel(
      controllerOf({
        kind: 'success',
        comment: 'из полного разбора',
        source: 'full-review',
        highlights: [],
        arrows: [],
      }),
    );
    expect(
      screen.getByTestId('ai-position-comment-desktop-source-label'),
    ).toHaveTextContent('From full review');
    expect(screen.getByTestId(T_BTN)).toHaveTextContent('Regenerate');
  });

  it('empty: показывает текст-заглушку', () => {
    renderPanel(controllerOf({ kind: 'empty' }));
    expect(screen.getByTestId('ai-position-comment-desktop-empty')).toBeInTheDocument();
  });

  it('error: показывает текст ошибки', () => {
    renderPanel(controllerOf({ kind: 'error', message: 'network' }));
    expect(screen.getByTestId('ai-position-comment-desktop-error')).toBeInTheDocument();
  });

  it('rate-limited: кнопка disabled, countdown в секундах', () => {
    renderPanel(controllerOf({ kind: 'rate-limited', retryAfterSec: 65 }));
    const btn = screen.getByTestId(T_BTN);
    expect(btn).toBeDisabled();
    // 65s → "1:05"
    expect(btn.textContent ?? '').toMatch(/1:05/);
    expect(
      screen.getByTestId('ai-position-comment-desktop-rate-limited'),
    ).toBeInTheDocument();
  });

  it('unauthenticated: кнопка disabled с tooltip + ссылка на /login', () => {
    renderPanel(controllerOf({ kind: 'unauthenticated' }));
    const btn = screen.getByTestId(T_BTN);
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Sign in to use AI evaluation');
    const link = screen.getByTestId('ai-position-comment-desktop-guest-link');
    expect(link).toHaveAttribute('href', '/login');
  });

  it('unsupported: кнопка disabled, текст «недоступны»', () => {
    renderPanel(controllerOf({ kind: 'unsupported' }));
    expect(screen.getByTestId(T_BTN)).toBeDisabled();
    expect(
      screen.getByTestId('ai-position-comment-desktop-unsupported'),
    ).toBeInTheDocument();
  });
});

describe('AiPositionCommentPanel — клики', () => {
  it('idle → клик вызывает request, не regenerate', () => {
    const ctl = controllerOf({ kind: 'idle' });
    renderPanel(ctl);
    fireEvent.click(screen.getByTestId(T_BTN));
    expect(ctl.request).toHaveBeenCalledTimes(1);
    expect(ctl.regenerate).not.toHaveBeenCalled();
  });

  it('success(full-review) → клик вызывает regenerate, не request', () => {
    const ctl = controllerOf({
      kind: 'success',
      comment: 'старый',
      source: 'full-review',
      highlights: [],
      arrows: [],
    });
    renderPanel(ctl);
    fireEvent.click(screen.getByTestId(T_BTN));
    expect(ctl.regenerate).toHaveBeenCalledTimes(1);
    expect(ctl.request).not.toHaveBeenCalled();
  });

  it('loading → клик не вызывает ни request ни regenerate', () => {
    const ctl = controllerOf({ kind: 'loading' });
    renderPanel(ctl);
    fireEvent.click(screen.getByTestId(T_BTN));
    expect(ctl.request).not.toHaveBeenCalled();
    expect(ctl.regenerate).not.toHaveBeenCalled();
  });

  it('unauthenticated → клик не вызывает request', () => {
    const ctl = controllerOf({ kind: 'unauthenticated' });
    renderPanel(ctl);
    fireEvent.click(screen.getByTestId(T_BTN));
    expect(ctl.request).not.toHaveBeenCalled();
  });
});

// --- KS-3691: overlay-переключатель -------------------------------------

describe('AiPositionCommentPanel — overlay toggle (KS-3691)', () => {
  const T_TOGGLE = 'ai-position-comment-desktop-overlay-toggle';

  it('overlay=null → кнопки нет', () => {
    renderPanel(
      controllerOf(
        {
          kind: 'success',
          comment: 'ок',
          source: 'live',
          highlights: [],
          arrows: [],
        },
        { overlay: null },
      ),
    );
    expect(screen.queryByTestId(T_TOGGLE)).toBeNull();
  });

  it('overlay есть и не скрыт → кнопка «Hide overlay»', () => {
    renderPanel(
      controllerOf(
        {
          kind: 'success',
          comment: 'ок',
          source: 'live',
          highlights: [{ square: 'd5', color: 'green' }],
          arrows: [],
        },
        {
          overlay: { highlights: [{ square: 'd5', color: 'green' }], arrows: [] },
          overlayHidden: false,
        },
      ),
    );
    const btn = screen.getByTestId(T_TOGGLE);
    expect(btn).toHaveTextContent('Hide overlay');
  });

  it('overlay есть и скрыт → кнопка «Show overlay»', () => {
    renderPanel(
      controllerOf(
        {
          kind: 'success',
          comment: 'ок',
          source: 'live',
          highlights: [{ square: 'd5', color: 'green' }],
          arrows: [],
        },
        {
          overlay: { highlights: [{ square: 'd5', color: 'green' }], arrows: [] },
          overlayHidden: true,
        },
      ),
    );
    const btn = screen.getByTestId(T_TOGGLE);
    expect(btn).toHaveTextContent('Show overlay');
  });

  it('клик по кнопке вызывает toggleOverlay', () => {
    const toggle = vi.fn();
    renderPanel(
      controllerOf(
        {
          kind: 'success',
          comment: 'ок',
          source: 'live',
          highlights: [{ square: 'd5', color: 'green' }],
          arrows: [],
        },
        {
          overlay: { highlights: [{ square: 'd5', color: 'green' }], arrows: [] },
          overlayHidden: false,
          toggleOverlay: toggle,
        },
      ),
    );
    fireEvent.click(screen.getByTestId(T_TOGGLE));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('source=full-review → overlay=null, кнопки нет даже при наличии highlights в state', () => {
    // Хук в этом сценарии всегда отдаёт overlay=null, проверяем что UI
    // действительно от него и зависит.
    renderPanel(
      controllerOf(
        {
          kind: 'success',
          comment: 'из полного разбора',
          source: 'full-review',
          highlights: [],
          arrows: [],
        },
        { overlay: null },
      ),
    );
    expect(screen.queryByTestId(T_TOGGLE)).toBeNull();
  });
});

describe('KS-3726: AiPositionCommentPanel — кнопка «Добавить в комментарий»', () => {
  const T_ADD = 'ai-position-comment-desktop-add-to-comment';

  const successState = (comment: string): AiCommentState => ({
    kind: 'success',
    comment,
    source: 'live',
    highlights: [],
    arrows: [],
  });

  function renderWithAdd(opts: {
    state: AiCommentState;
    onAddToComment?: (text: string) => void;
    currentMoveComment?: string | null;
  }) {
    return render(
      <MemoryRouter>
        <AiPositionCommentPanel
          controller={controllerOf(opts.state)}
          testIdSuffix="desktop"
          onAddToComment={opts.onAddToComment}
          currentMoveComment={opts.currentMoveComment ?? null}
        />
      </MemoryRouter>,
    );
  }

  it('без onAddToComment кнопка не рендерится (sandbox / read-only)', () => {
    renderWithAdd({ state: successState('Хороший ход.') });
    expect(screen.queryByTestId(T_ADD)).toBeNull();
  });

  it('с onAddToComment + success кнопка показывается и активна', () => {
    renderWithAdd({
      state: successState('Хороший ход.'),
      onAddToComment: vi.fn(),
    });
    const btn = screen.getByTestId(T_ADD);
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent('Add to move comment');
  });

  it('клик зовёт onAddToComment с trimmed AI-текстом', () => {
    const onAdd = vi.fn();
    renderWithAdd({
      state: successState('  Хороший ход.  '),
      onAddToComment: onAdd,
    });
    fireEvent.click(screen.getByTestId(T_ADD));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith('Хороший ход.');
  });

  it('если AI-текст уже в комментарии хода — кнопка disabled, лейбл «Добавлено»', () => {
    const onAdd = vi.fn();
    renderWithAdd({
      state: successState('Хороший ход.'),
      onAddToComment: onAdd,
      currentMoveComment: 'Мой пред. коммент.\nХороший ход.',
    });
    const btn = screen.getByTestId(T_ADD);
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Added');
    fireEvent.click(btn);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('full-review (source) тоже даёт активную кнопку, если комментарий ещё не в move.comment', () => {
    // Кейс: full-review-комментарий взят из move.comment по globalIndex.
    // По умолчанию AnalysisPage передаёт currentMoveComment === fullReview
    // → alreadyInComment=true → «Добавлено». Этот тест проверяет
    // обратный сценарий: текст есть, но в move.comment его нет (например,
    // регенерация перезаписала state в RAM-кэше). Кнопка должна
    // работать.
    renderWithAdd({
      state: {
        kind: 'success',
        comment: 'Свежая оценка из live-запроса.',
        source: 'full-review',
        highlights: [],
        arrows: [],
      },
      onAddToComment: vi.fn(),
      currentMoveComment: null,
    });
    expect(screen.getByTestId(T_ADD)).not.toBeDisabled();
  });

  it('в loading / empty / error / idle / rate-limited / unsupported / unauthenticated кнопка не показывается', () => {
    const onAdd = vi.fn();
    const states: AiCommentState[] = [
      { kind: 'loading' },
      { kind: 'empty' },
      { kind: 'error', message: 'network' },
      { kind: 'idle' },
      { kind: 'rate-limited', retryAfterSec: 30 },
      { kind: 'unsupported' },
      { kind: 'unauthenticated' },
    ];
    for (const state of states) {
      const { unmount } = renderWithAdd({ state, onAddToComment: onAdd });
      expect(screen.queryByTestId(T_ADD)).toBeNull();
      unmount();
    }
  });
});

describe('AiPositionCommentPanel — soft-counter', () => {
  it('показывает used/limit', () => {
    renderPanel(
      controllerOf(
        { kind: 'idle' },
        {
          softCounter: { used: 7, limit: SOFT_LIMIT, windowMin: SOFT_WINDOW_MIN },
        },
      ),
    );
    expect(
      screen.getByTestId('ai-position-comment-desktop-counter'),
    ).toHaveTextContent(`7/${SOFT_LIMIT}`);
  });
});
