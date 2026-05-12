import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import {
  ImportPgnDialog,
  countGamesInPgn,
} from './ImportPgnDialog';

const importPgnMock = vi.fn();
vi.mock('../../api/studiesApi', () => ({
  studiesApi: {
    importPgn: (slug: string, pgn: string) => importPgnMock(slug, pgn),
  },
}));

beforeEach(() => {
  importPgnMock.mockReset();
});

describe('countGamesInPgn (KS-2830)', () => {
  it('пустая строка → 0', () => {
    expect(countGamesInPgn('')).toBe(0);
    expect(countGamesInPgn('   ')).toBe(0);
  });

  it('одна игра с [Event ...] → 1', () => {
    expect(countGamesInPgn('[Event "Demo"]\n1. e4 e5')).toBe(1);
  });

  it('три игры с [Event ...] → 3', () => {
    const pgn = `[Event "Game 1"]\n[White "A"]\n1. e4\n\n[Event "Game 2"]\n1. d4\n\n[Event "Game 3"]\n1. c4`;
    expect(countGamesInPgn(pgn)).toBe(3);
  });

  it('PGN без [Event] но не пустой → 1 (бэк попытается импортировать)', () => {
    expect(countGamesInPgn('1. e4 e5 2. Nf3')).toBe(1);
  });

  it('case-insensitive [event]', () => {
    expect(countGamesInPgn('[event "x"]\n1. e4')).toBe(1);
  });
});

describe('<ImportPgnDialog> (KS-2830)', () => {
  it('рендерит модалку с тестовыми testid', () => {
    renderWithProviders(
      <ImportPgnDialog slug="demo" onClose={() => {}} onImported={() => {}} />,
    );
    expect(screen.getByTestId('import-pgn-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('import-pgn-dialog-textarea')).toBeInTheDocument();
    expect(screen.getByTestId('import-pgn-dialog-submit')).toBeInTheDocument();
  });

  it('submit с пустым PGN → ошибка', () => {
    renderWithProviders(
      <ImportPgnDialog slug="demo" onClose={() => {}} onImported={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('import-pgn-dialog-submit'));
    // Submit-кнопка disabled при пустом значении, но клик мы делаем
    // напрямую — UI просто не вызывает submit. Проверим что importPgn
    // не вызван.
    expect(importPgnMock).not.toHaveBeenCalled();
  });

  it('успешный submit → studiesApi.importPgn + onImported + onClose', async () => {
    importPgnMock.mockResolvedValue({
      created: [
        { id: 'c1', name: 'Game 1' },
        { id: 'c2', name: 'Game 2' },
      ],
    });
    const onImported = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <ImportPgnDialog slug="demo" onClose={onClose} onImported={onImported} />,
    );
    const ta = screen.getByTestId('import-pgn-dialog-textarea');
    fireEvent.change(ta, { target: { value: '[Event "X"]\n1. e4' } });
    fireEvent.click(screen.getByTestId('import-pgn-dialog-submit'));
    await waitFor(() =>
      expect(importPgnMock).toHaveBeenCalledWith('demo', '[Event "X"]\n1. e4'),
    );
    expect(onImported).toHaveBeenCalledWith(2);
    expect(onClose).toHaveBeenCalled();
  });

  it('ошибка importPgn → error-display', async () => {
    importPgnMock.mockRejectedValue(new Error('Chapter limit exceeded'));
    renderWithProviders(
      <ImportPgnDialog slug="demo" onClose={() => {}} onImported={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('import-pgn-dialog-textarea'), {
      target: { value: '1. e4' },
    });
    fireEvent.click(screen.getByTestId('import-pgn-dialog-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('import-pgn-dialog-error')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('import-pgn-dialog-error')).toHaveTextContent(
      /chapter limit/i,
    );
  });

  it('клик cancel → onClose', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ImportPgnDialog slug="demo" onClose={onClose} onImported={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('import-pgn-dialog-cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('preview count обновляется при изменении PGN', () => {
    renderWithProviders(
      <ImportPgnDialog slug="demo" onClose={() => {}} onImported={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('import-pgn-dialog-textarea'), {
      target: { value: '[Event "A"]\n1. e4\n\n[Event "B"]\n1. d4' },
    });
    expect(screen.getByTestId('import-pgn-dialog-count').textContent).toMatch(
      /2/,
    );
  });
});
