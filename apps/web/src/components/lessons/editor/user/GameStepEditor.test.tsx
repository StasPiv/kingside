import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import type { AnalysisListItem, GameStepPayload } from '@kingside/shared';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { GameStepEditor } from './GameStepEditor';

/**
 * KS-3181 (ADR-072 §7 F1): редактор шага «Партия». Покрытие:
 *  - переключение sourceType (pgn <-> workshop_analysis);
 *  - PGN-режим: валидный/невалидный PGN, превышение 200 КБ, парсинг meta;
 *  - workshop-режим: загрузка списка через `/analyses`, поиск, выбор
 *    элемента (`onChange` приходит `analysisId`, без `pgn`).
 *
 * `api.get` мочим точечно — `useSavedAnalyses` саму мы тут не зовём,
 * `GameStepEditor` дергает `api.get('/analyses?…')` напрямую.
 */

const apiGetMock = vi.fn();
vi.mock('../../../../api', () => ({
  api: {
    get: (path: string) => apiGetMock(path),
  },
}));

function mkPayload(over: Partial<GameStepPayload> = {}): GameStepPayload {
  return { type: 'game', sourceType: 'pgn', pgn: '', ...over } as GameStepPayload;
}

function mkAnalysis(over: Partial<AnalysisListItem> = {}): AnalysisListItem {
  return {
    id: 'a1',
    title: 'My fave game',
    headline: null,
    opening: null,
    event: null,
    white: null,
    black: null,
    result: null,
    category: null,
    tags: [],
    createdAt: '2026-05-21T00:00:00Z',
    ...over,
  };
}

describe('<GameStepEditor> (KS-3181)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
  });

  it('по умолчанию рендерит PGN-режим с пустой textarea', () => {
    renderWithProviders(
      <GameStepEditor payload={mkPayload()} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('game-step-editor')).toBeTruthy();
    expect(
      screen.getByTestId('game-step-editor').getAttribute('data-source-type'),
    ).toBe('pgn');
    expect(
      (screen.getByTestId('game-step-editor-pgn-textarea') as HTMLTextAreaElement)
        .value,
    ).toBe('');
  });

  it('валидный PGN → onChange отдаёт распарсенный meta + show OK hint', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <GameStepEditor payload={mkPayload()} onChange={onChange} />,
    );
    const ta = screen.getByTestId(
      'game-step-editor-pgn-textarea',
    ) as HTMLTextAreaElement;
    const pgn =
      '[Event "Test"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0';
    fireEvent.change(ta, { target: { value: pgn } });

    await waitFor(() =>
      expect(screen.queryByTestId('game-step-editor-pgn-ok')).toBeTruthy(),
    );
    expect(screen.queryByTestId('game-step-editor-pgn-error')).toBeNull();
    // Последний onChange должен содержать meta из PGN-заголовка.
    const lastCall = onChange.mock.calls.at(-1)?.[0] as GameStepPayload;
    expect(lastCall.type).toBe('game');
    expect(lastCall.sourceType).toBe('pgn');
    expect(lastCall.pgn).toBe(pgn);
    expect(lastCall.meta).toEqual({
      event: 'Test',
      white: 'Alice',
      black: 'Bob',
      result: '1-0',
    });
  });

  it('невалидный PGN → показывает inline-ошибку, onChange всё равно вызывается (родитель отсечёт PATCH)', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <GameStepEditor payload={mkPayload()} onChange={onChange} />,
    );
    const ta = screen.getByTestId(
      'game-step-editor-pgn-textarea',
    ) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '1. e4!?? this is not pgn' } });

    await waitFor(() =>
      expect(screen.queryByTestId('game-step-editor-pgn-error')).toBeTruthy(),
    );
    // OK-hint при ошибке не показывается.
    expect(screen.queryByTestId('game-step-editor-pgn-ok')).toBeNull();
    // aria-invalid выставлен.
    expect(ta.getAttribute('aria-invalid')).toBe('true');
  });

  it('переключение «Из моих анализов» → загружается список и кликом выбирается анализ', async () => {
    const onChange = vi.fn();
    const items = [
      mkAnalysis({ id: 'a1', title: 'Tal vs Botvinnik', white: 'Tal' }),
      mkAnalysis({ id: 'a2', title: 'Kramnik study', white: 'Kramnik' }),
    ];
    apiGetMock.mockResolvedValue(items);
    const { rerender } = renderWithProviders(
      <GameStepEditor payload={mkPayload()} onChange={onChange} />,
    );

    fireEvent.click(screen.getByTestId('game-step-editor-tab-workshop'));
    // Родитель в реальной жизни обновит payload → имитируем перерендер.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'game',
        sourceType: 'workshop_analysis',
      }),
    );
    rerender(
      <GameStepEditor
        payload={mkPayload({ sourceType: 'workshop_analysis' })}
        onChange={onChange}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId('game-step-editor-workshop-list')).toBeTruthy(),
    );
    expect(apiGetMock).toHaveBeenCalledWith('/analyses?limit=100&offset=0');

    onChange.mockClear();
    // Кликаем по кнопке внутри строки (li.testid — обёртка, click на ней
    // не вызывает onClick потомка).
    const row = screen.getByTestId('game-step-editor-workshop-item-a1');
    const btn = row.querySelector('button');
    if (!btn) throw new Error('analysis button missing');
    fireEvent.click(btn);
    expect(onChange).toHaveBeenCalledTimes(1);
    const submit = onChange.mock.calls[0][0] as GameStepPayload;
    expect(submit.sourceType).toBe('workshop_analysis');
    expect(submit.analysisId).toBe('a1');
    // KS-3181: pgn НЕ отправляется в workshop-режиме — backend сам
    // сделает snapshot. meta берётся из элемента списка для preview.
    expect(submit.pgn).toBeUndefined();
    expect(submit.meta).toEqual({ white: 'Tal' });
  });

  it('workshop-режим: фильтр поиска отбирает анализы по белым/чёрным/event', async () => {
    apiGetMock.mockResolvedValue([
      mkAnalysis({ id: 'a1', title: 'A', white: 'Carlsen', black: 'Anand' }),
      mkAnalysis({ id: 'a2', title: 'B', white: 'Tal', black: 'Botvinnik' }),
    ]);
    renderWithProviders(
      <GameStepEditor
        payload={mkPayload({ sourceType: 'workshop_analysis' })}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId('game-step-editor-workshop-list')).toBeTruthy(),
    );

    fireEvent.change(screen.getByTestId('game-step-editor-workshop-search'), {
      target: { value: 'tal' },
    });

    expect(screen.queryByTestId('game-step-editor-workshop-item-a1')).toBeNull();
    expect(screen.queryByTestId('game-step-editor-workshop-item-a2')).toBeTruthy();
  });

  it('workshop-режим без выбора анализа → видна подсказка noSelection', async () => {
    apiGetMock.mockResolvedValue([]);
    renderWithProviders(
      <GameStepEditor
        payload={mkPayload({ sourceType: 'workshop_analysis' })}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId('game-step-editor-workshop-empty')).toBeTruthy(),
    );
    expect(
      screen.queryByTestId('game-step-editor-workshop-no-selection'),
    ).toBeTruthy();
  });

  it('workshop-режим: ошибка загрузки списка → показывает error-плашку', async () => {
    apiGetMock.mockRejectedValue(new Error('boom'));
    renderWithProviders(
      <GameStepEditor
        payload={mkPayload({ sourceType: 'workshop_analysis' })}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId('game-step-editor-workshop-error')).toBeTruthy(),
    );
  });

  it('PGN > 200 КБ → показывает overLimit и aria-invalid=true', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <GameStepEditor payload={mkPayload()} onChange={onChange} />,
    );
    const ta = screen.getByTestId(
      'game-step-editor-pgn-textarea',
    ) as HTMLTextAreaElement;
    // 201 КБ валидного-формата мусора — chess.js не сможет распарсить,
    // но проверка overLimit от валидности не зависит.
    const huge = 'x'.repeat(201 * 1024);
    fireEvent.change(ta, { target: { value: huge } });

    await waitFor(() =>
      expect(screen.queryByTestId('game-step-editor-pgn-over-limit')).toBeTruthy(),
    );
    expect(ta.getAttribute('aria-invalid')).toBe('true');
  });
});
