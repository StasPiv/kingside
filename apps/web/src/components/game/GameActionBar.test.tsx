import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
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

  afterEach(() => {
    // KS-4294: тесты, использующие vi.useFakeTimers, должны откатить
    // к реальным до следующего it, иначе глобальный userEvent.click
    // ждёт реальный таймер бесконечно.
    vi.useRealTimers();
  });

  describe('status="active"', () => {
    it('рендерит 4 действия: Сдаться, Ничья, Чат, Ещё', () => {
      renderWithProviders(<GameActionBar {...defaults} />);
      expect(screen.getByTestId('game-action-bar-resign')).toBeInTheDocument();
      expect(screen.getByTestId('game-action-bar-draw')).toBeInTheDocument();
      expect(screen.getByTestId('game-action-bar-chat')).toBeInTheDocument();
      expect(screen.getByTestId('game-action-bar-more')).toBeInTheDocument();
    });

    it('первый тап «Сдаться» НЕ вызывает onResign, второй вызывает (KS-4294)', async () => {
      renderWithProviders(<GameActionBar {...defaults} />);
      const btn = screen.getByTestId('game-action-bar-resign');
      await userEvent.click(btn);
      expect(defaults.onResign).not.toHaveBeenCalled();
      await userEvent.click(btn);
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

    it('бейдж непрочитанных скрыт при chatUnreadCount=0', () => {
      renderWithProviders(<GameActionBar {...defaults} chatUnreadCount={0} />);
      expect(
        screen.queryByTestId('game-action-bar-chat-badge'),
      ).not.toBeInTheDocument();
    });

    it('бейдж непрочитанных показывает число при chatUnreadCount>0', () => {
      renderWithProviders(<GameActionBar {...defaults} chatUnreadCount={5} />);
      expect(
        screen.getByTestId('game-action-bar-chat-badge'),
      ).toHaveTextContent('5');
    });

    it('бейдж показывает «99+» при chatUnreadCount>99', () => {
      renderWithProviders(<GameActionBar {...defaults} chatUnreadCount={150} />);
      expect(
        screen.getByTestId('game-action-bar-chat-badge'),
      ).toHaveTextContent('99+');
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

    it('KS-4295: пункт «Помощь» виден при onHelp, скрыт без него', async () => {
      const onHelp = vi.fn();
      const { rerender } = renderWithProviders(
        <GameActionBar {...defaults} onHelp={onHelp} />,
      );
      await userEvent.click(screen.getByTestId('game-action-bar-more'));
      expect(screen.getByTestId('game-action-bar-help')).toBeInTheDocument();
      // Без onHelp пункт отсутствует.
      rerender(<GameActionBar {...defaults} onHelp={undefined} />);
      await userEvent.click(screen.getByTestId('game-action-bar-more'));
      expect(
        screen.queryByTestId('game-action-bar-help'),
      ).not.toBeInTheDocument();
    });

    it('KS-4295: клик по «Помощь» вызывает onHelp и закрывает меню', async () => {
      const onHelp = vi.fn();
      renderWithProviders(<GameActionBar {...defaults} onHelp={onHelp} />);
      await userEvent.click(screen.getByTestId('game-action-bar-more'));
      await userEvent.click(screen.getByTestId('game-action-bar-help'));
      expect(onHelp).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByTestId('game-action-bar-more-menu'),
      ).not.toBeInTheDocument();
    });
  });

  describe('KS-4294: двухтаповое подтверждение «Сдаться»', () => {
    it('первый тап переключает кнопку в armed-состояние с лейблом «Confirm?»', async () => {
      renderWithProviders(<GameActionBar {...defaults} />);
      const btn = screen.getByTestId('game-action-bar-resign');
      expect(btn).not.toHaveAttribute('data-armed');
      expect(btn).toHaveTextContent('Resign');
      await userEvent.click(btn);
      expect(btn).toHaveAttribute('data-armed', 'true');
      expect(btn).toHaveClass('game-action-bar__btn--armed');
      expect(btn).toHaveTextContent('Confirm?');
      expect(defaults.onResign).not.toHaveBeenCalled();
    });

    it('сбрасывается по таймауту 2 с без второго тапа', async () => {
      // KS-4294: используем `fireEvent.click` вместо `userEvent.click`,
      // т. к. user-event версии в проекте конфликтует с fake-timers
      // (зависает на ожидании реального setTimeout). fireEvent
      // синхронен и устойчив к fake-timers; `act` нужен, чтобы
      // setState из setTimeout-колбэка попал в текущий render-цикл.
      vi.useFakeTimers();
      renderWithProviders(<GameActionBar {...defaults} />);
      const btn = screen.getByTestId('game-action-bar-resign');
      fireEvent.click(btn);
      expect(btn).toHaveAttribute('data-armed', 'true');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(btn).not.toHaveAttribute('data-armed');
      expect(btn).toHaveTextContent('Resign');
      expect(defaults.onResign).not.toHaveBeenCalled();
    });

    it('после сброса требуется снова первый тап перед onResign', async () => {
      vi.useFakeTimers();
      renderWithProviders(<GameActionBar {...defaults} />);
      const btn = screen.getByTestId('game-action-bar-resign');
      fireEvent.click(btn);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      // Следующий тап снова первый — не вызывает onResign, ставит armed.
      fireEvent.click(btn);
      expect(btn).toHaveAttribute('data-armed', 'true');
      expect(defaults.onResign).not.toHaveBeenCalled();
    });

    it('смена статуса на finished сбрасывает armed-состояние', async () => {
      const { rerender } = renderWithProviders(<GameActionBar {...defaults} />);
      await userEvent.click(screen.getByTestId('game-action-bar-resign'));
      expect(screen.getByTestId('game-action-bar-resign')).toHaveAttribute(
        'data-armed',
        'true',
      );
      rerender(<GameActionBar {...defaults} status="finished" />);
      // На finished кнопка resign больше не рендерится; armed-состояние
      // погашено эффектом — следующий рендер active не должен показать armed.
      rerender(<GameActionBar {...defaults} status="active" />);
      expect(
        screen.getByTestId('game-action-bar-resign'),
      ).not.toHaveAttribute('data-armed');
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
