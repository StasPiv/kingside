import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { createRef } from 'react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { AnalysisBoard } from './AnalysisBoard';
import type { GameMetaInfo } from '../../components/GameMetaBar';
import type { ChessMove } from '../../review/types';

/**
 * KS-2864 (ADR-060 §10.1 FR2): smoke-тесты извлечённого AnalysisBoard.
 *
 * Компонент presentational — проверяем рендер по props (gameInfo,
 * pendingPromotion, variationChooser) и проброс callback'ов.
 */

const DEFAULT_BOARD_OPTIONS = {
  position: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  boardOrientation: 'white' as const,
  allowDragging: false,
  animationDurationInMs: 0,
};

function makeProps(overrides: Partial<Parameters<typeof AnalysisBoard>[0]> = {}) {
  const ref = createRef<HTMLDivElement | null>();
  return {
    gameInfo: undefined,
    boardContainerRef: ref,
    boardOptions: DEFAULT_BOARD_OPTIONS,
    annotationsKey: 'k1',
    displayedLines: [],
    evalIsBlackTurn: false,
    pendingPromotion: null,
    onPromotionChoice: () => {},
    onPromotionCancel: () => {},
    variationChooser: null,
    onVariationSelect: () => {},
    onVariationClose: () => {},
    ...overrides,
  };
}

describe('<AnalysisBoard> (KS-2864)', () => {
  it('рендерит board-container и пустой game-meta-bar placeholder без gameInfo', () => {
    renderWithProviders(<AnalysisBoard {...makeProps()} />);
    expect(screen.getByTestId('analysis-board-container')).toBeInTheDocument();
    // placeholder game-meta-bar — пустые контейнеры
    const metaBars = document.querySelectorAll('.game-meta-bar');
    expect(metaBars.length).toBeGreaterThan(0);
  });

  it('рендерит GameMetaBar когда передан gameInfo', () => {
    const gameInfo: GameMetaInfo = {
      white: { username: 'Alice', rating: 1500 },
      black: { username: 'Bob', rating: 1400 },
    };
    renderWithProviders(<AnalysisBoard {...makeProps({ gameInfo })} />);
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bob').length).toBeGreaterThan(0);
  });

  it('promotion-overlay отображается при pendingPromotion и клик по фигуре вызывает onPromotionChoice', () => {
    const onPromotionChoice = vi.fn();
    renderWithProviders(
      <AnalysisBoard
        {...makeProps({
          pendingPromotion: { from: 'e7', to: 'e8' },
          onPromotionChoice,
        })}
      />,
    );
    const overlay = screen.getByTestId('analysis-promotion-overlay');
    expect(overlay).toBeInTheDocument();
    const queenBtn = overlay.querySelector(
      '[data-piece="wQ"]',
    ) as HTMLButtonElement | null;
    expect(queenBtn).not.toBeNull();
    fireEvent.click(queenBtn!);
    expect(onPromotionChoice).toHaveBeenCalledWith('q');
  });

  it('клик по overlay (вне диалога) вызывает onPromotionCancel', () => {
    const onPromotionCancel = vi.fn();
    renderWithProviders(
      <AnalysisBoard
        {...makeProps({
          pendingPromotion: { from: 'e7', to: 'e8' },
          onPromotionCancel,
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('analysis-promotion-overlay'));
    expect(onPromotionCancel).toHaveBeenCalled();
  });

  it('overlay отсутствует если pendingPromotion=null', () => {
    renderWithProviders(<AnalysisBoard {...makeProps()} />);
    expect(
      screen.queryByTestId('analysis-promotion-overlay'),
    ).not.toBeInTheDocument();
  });

  it('черная сторона promotion (to ends with "1") рисует чёрные фигуры', () => {
    renderWithProviders(
      <AnalysisBoard
        {...makeProps({
          pendingPromotion: { from: 'e2', to: 'e1' },
        })}
      />,
    );
    const overlay = screen.getByTestId('analysis-promotion-overlay');
    expect(overlay.querySelector('[data-piece="bQ"]')).not.toBeNull();
    expect(overlay.querySelector('[data-piece="bR"]')).not.toBeNull();
    expect(overlay.querySelector('[data-piece="bB"]')).not.toBeNull();
    expect(overlay.querySelector('[data-piece="bN"]')).not.toBeNull();
  });

  it('VariationChooser рендерится когда передан variationChooser', () => {
    const mainLine = { san: 'e4', uci: 'e2e4', ply: 1 } as unknown as ChessMove;
    const variations = [
      [{ san: 'd4', uci: 'd2d4', ply: 1 } as unknown as ChessMove],
    ];
    renderWithProviders(
      <AnalysisBoard
        {...makeProps({
          variationChooser: { mainLine, variations },
        })}
      />,
    );
    // VariationChooser отображает SAN-ходы; ищем по тексту 'e4'.
    expect(screen.getAllByText(/e4/).length).toBeGreaterThan(0);
  });

  it('VariationChooser отсутствует когда variationChooser=null', () => {
    renderWithProviders(<AnalysisBoard {...makeProps()} />);
    // Проверяем что нет элементов VariationChooser (его data-testid если есть).
    expect(document.querySelector('.variation-chooser')).toBeNull();
  });
});
