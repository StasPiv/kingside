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
      controllerOf({ kind: 'success', comment: 'хорошая структура', source: 'live' }),
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
