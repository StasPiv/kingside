/**
 * KS-4144 / KS-4150: локальная партия гостя против бота. Полностью
 * клиентская — ни REST, ни WebSocket не используются.
 *
 * UI отрисовывает `GameShell` (общий с онлайн-партией `/game/:id`):
 * та же доска, те же часы, тот же список ходов, тот же блок действий
 * и та же модалка результата. Различие — только в источнике данных,
 * который собирается через `useLocalBotGame` (chess.js + Stockfish 18
 * WASM + клиентский таймер).
 *
 * По умолчанию контроль времени 10+0. Опционально можно передать
 * `state.tc = { initialSec, incrementSec }` при навигации.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

import { GameShell } from '../components/game/GameShell';
import {
  useLocalBotGame,
  type LocalBotTimeControl,
} from '../hooks/useLocalBotGame';

/**
 * KS-4148: на `/play/local-bot` по умолчанию используем стандартный
 * набор фигур react-chessboard (pieceSet 'standard'), а не дефолт
 * проекта (chessnut). Перебиваем только когда пользователь не делал
 * явного выбора pieceSet — в этом случае localStorage пустой.
 */
function readHasExplicitPieceSet(): boolean {
  try {
    return localStorage.getItem('pieceSet') !== null;
  } catch {
    return false;
  }
}

type PieceColor = 'white' | 'black' | 'random';
interface LocationState {
  level?: number;
  color?: PieceColor;
  tc?: LocalBotTimeControl;
}

export function LocalBotGamePage() {
  const { t } = useTranslation();
  const location = useLocation();
  const state = (location.state ?? {}) as LocationState;

  const game = useLocalBotGame({
    color: state.color,
    level: state.level,
    playerName: t('game.you', 'You'),
    botName: t('lobby.bot', 'Bot'),
    timeControl: state.tc ?? { initialSec: 600, incrementSec: 0 },
  });

  // Модалка результата: показываем при первом переходе в 'finished'
  // и закрываем при старте новой партии или клике по подложке.
  const [showResultModal, setShowResultModal] = useState(false);
  useEffect(() => {
    if (game.status === 'finished') setShowResultModal(true);
  }, [game.status]);

  const handleNewGame = useCallback(() => {
    setShowResultModal(false);
    game.onNewGame();
  }, [game]);

  // KS-4148: если пользователь явно не выбрал pieceSet — форсим
  // стандартный (react-chessboard default). Если выбрал — уважаем.
  const forceStandardPieces = useMemo(() => !readHasExplicitPieceSet(), []);

  return (
    <GameShell
      chess={game.chess}
      fen={game.fen}
      moves={game.moves}
      clocks={game.clocks}
      status={game.status}
      result={game.result}
      playerColor={game.playerColor}
      players={game.players}
      onMove={game.onMove}
      enablePremove={false}
      lastMove={game.lastMove}
      isBot
      botLevel={game.botLevel}
      canResign
      onResign={game.onResign}
      onNewGame={handleNewGame}
      newGameLabel={t('game.newGame', 'New game')}
      showResultModal={showResultModal}
      onCloseResultModal={() => setShowResultModal(false)}
      backLink={{ to: '/play', label: t('game.backToLobby', 'Back to lobby') }}
      forceStandardPieces={forceStandardPieces}
      belowBoardBlock={
        // KS-4151: блок отрисовывается ВСЕГДА с фиксированной высотой.
        // Раньше div появлялся/исчезал при botThinking → менялось число
        // детей `.game-board-area` (flex column, justify-content: center)
        // и доска визуально смещалась вверх/вниз на каждом ходе бота —
        // отсюда «дрожание». Сейчас высота 24px зарезервирована всегда,
        // меняется только текстовое содержимое — без layout shift.
        <div
          className="local-bot-below"
          style={{
            marginTop: 12,
            minHeight: 24,
            lineHeight: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
          }}
        >
          {game.botError ? (
            <span
              className="local-bot-error"
              data-testid="local-bot-error"
              style={{ color: '#ef4444' }}
              role="alert"
            >
              {t('game.botEngineError', 'Bot engine could not start: {{msg}}', {
                msg: game.botError,
              })}
            </span>
          ) : game.status === 'active' && game.botThinking ? (
            <span
              className="local-bot-status"
              data-testid="local-bot-status-bot"
            >
              {t('game.botThinking', 'Bot is thinking…')}
            </span>
          ) : null}
        </div>
      }
    />
  );
}
