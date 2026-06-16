import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, userEvent } from '../../test/test-utils';
import { GameActionBar } from './GameActionBar';

describe('KS-4290 / ADR-134 §2: GameActionBar', () => {
  const defaults = {
    status: 'active' as const,
    canResign: true,
    onResign: vi.fn(),
    canOfferDraw: true,
    onOfferDraw: vi.fn(),
    onChatClick: vi.fn(),
    muted: false,
    onToggleMute: vi.fn(),
    onBackToLobby: vi.fn(),
  };

  beforeEach(() => {
    Object.values(defaults).forEach((v) => {
      if (typeof v === 'function' && 'mockReset' in v) v.mockReset();
    });
  });

  describe('status="active"', () => {
    it('рендерит 4 действия: Сдаться, Ничья, Чат, Ещё', () => {
      renderWithProviders(<GameActionBar {...defaults} />);
      expect(screen.getByTestId('game-action-bar-resign')).toBeInTheDocument();
      expect(screen.getByTestId('game-action-bar-draw')).toBeInTheDocument();
      expect(screen.getByTestId('game-action-bar-chat')).toBeInTheDocument();
      expect(screen.getByTestId('game-action-bar-more')).toBeInTheDocument();
    });

    it('клик «Сдаться» вызывает onResign', async () => {
      renderWithProviders(<GameActionBar {...defaults} />);
      await userEvent.click(screen.getByTestId('game-action-bar-resign'));
      expect(defaults.onResign).toHaveBeenCalledTimes(1);
    });

    it('клик «Ничья» вызывает onOfferDraw', async () => {
      renderWithProviders(<GameActionBar {...defaults} />);
      await userEvent.click(screen.getByTestId('game-action-bar-draw'));
      expect(defaults.onOfferDraw).toHaveBeenCalledTimes(1);
    });

    it('кнопка «Сдаться» disabled, если canResign=false', () => {
      renderWithProviders(<GameActionBar {...defaults} canResign={false} />);
      expect(screen.getByTestId('game-action-bar-resign')).toBeDisabled();
    });

    it('кнопка «Ничья» disabled, если canOfferDraw=false', () => {
      renderWithProviders(<GameActionBar {...defaults} canOfferDraw={false} />);
      expect(screen.getByTestId('game-action-bar-draw')).toBeDisabled();
    });

    it('кнопка «Чат» disabled, если onChatClick не передан', () => {
      renderWithProviders(
        <GameActionBar {...defaults} onChatClick={undefined} />,
      );
      expect(screen.getByTestId('game-action-bar-chat')).toBeDisabled();
    });

    it('меню «Ещё» открывается по клику и содержит «Mute», «Lobby»', async () => {
      renderWithProviders(<GameActionBar {...defaults} />);
      expect(
        screen.queryByTestId('game-action-bar-more-menu'),
      ).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('game-action-bar-more'));
      expect(
        screen.getByTestId('game-action-bar-more-menu'),
      ).toBeInTheDocument();
      expect(screen.getByTestId('game-action-bar-mute')).toBeInTheDocument();
      expect(screen.getByTestId('game-action-bar-lobby')).toBeInTheDocument();
    });

    it('клик по «Mute» в меню вызывает onToggleMute и закрывает меню', async () => {
      renderWithProviders(<GameActionBar {...defaults} />);
      await userEvent.click(screen.getByTestId('game-action-bar-more'));
      await userEvent.click(screen.getByTestId('game-action-bar-mute'));
      expect(defaults.onToggleMute).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByTestId('game-action-bar-more-menu'),
      ).not.toBeInTheDocument();
    });

    it('клик по «Lobby» в меню вызывает onBackToLobby и закрывает меню', async () => {
      renderWithProviders(<GameActionBar {...defaults} />);
      await userEvent.click(screen.getByTestId('game-action-bar-more'));
      await userEvent.click(screen.getByTestId('game-action-bar-lobby'));
      expect(defaults.onBackToLobby).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByTestId('game-action-bar-more-menu'),
      ).not.toBeInTheDocument();
    });

    it('пункт «Lobby» скрыт, если onBackToLobby не передан', async () => {
      renderWithProviders(
        <GameActionBar {...defaults} onBackToLobby={undefined} />,
      );
      await userEvent.click(screen.getByTestId('game-action-bar-more'));
      expect(
        screen.queryByTestId('game-action-bar-lobby'),
      ).not.toBeInTheDocument();
    });
  });

  describe('status="finished"', () => {
    it('рендерит pill «Партия завершена ▲» с переданным лейблом', () => {
      renderWithProviders(
        <GameActionBar
          {...defaults}
          status="finished"
          resultPillLabel="Victory"
          onExpandResult={vi.fn()}
        />,
      );
      const pill = screen.getByTestId('game-action-bar-result-pill');
      expect(pill).toBeInTheDocument();
      expect(pill).toHaveTextContent('Victory ▲');
    });

    it('клик по pill вызывает onExpandResult', async () => {
      const onExpand = vi.fn();
      renderWithProviders(
        <GameActionBar
          {...defaults}
          status="finished"
          resultPillLabel="Defeat"
          onExpandResult={onExpand}
        />,
      );
      await userEvent.click(screen.getByTestId('game-action-bar-result-pill'));
      expect(onExpand).toHaveBeenCalledTimes(1);
    });

    it('pill не рендерится без resultPillLabel/onExpandResult (sheet раскрыт)', () => {
      renderWithProviders(<GameActionBar {...defaults} status="finished" />);
      expect(
        screen.queryByTestId('game-action-bar-result-pill'),
      ).not.toBeInTheDocument();
    });

    it('кнопки активной игры не рендерятся в finished', () => {
      renderWithProviders(<GameActionBar {...defaults} status="finished" />);
      expect(
        screen.queryByTestId('game-action-bar-resign'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('game-action-bar-draw'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('game-action-bar-more'),
      ).not.toBeInTheDocument();
    });
  });

  describe('status="waiting"', () => {
    it('рендерит контейнер-резерв без действий (без onCancelSearch)', () => {
      renderWithProviders(<GameActionBar {...defaults} status="waiting" />);
      expect(screen.getByTestId('game-action-bar')).toBeInTheDocument();
      expect(
        screen.queryByTestId('game-action-bar-resign'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('game-action-bar-cancel-search'),
      ).not.toBeInTheDocument();
    });

    it('рендерит primary-кнопку «Отменить поиск», если onCancelSearch передан', async () => {
      const onCancel = vi.fn();
      renderWithProviders(
        <GameActionBar
          {...defaults}
          status="waiting"
          onCancelSearch={onCancel}
        />,
      );
      const btn = screen.getByTestId('game-action-bar-cancel-search');
      expect(btn).toBeInTheDocument();
      await userEvent.click(btn);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
