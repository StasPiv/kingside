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
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

import { GameShell } from '../components/game/GameShell';
import {
  useLocalBotGame,
  type LocalBotTimeControl,
} from '../hooks/useLocalBotGame';

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
      belowBoardBlock={
        game.botError ? (
          <div
            className="local-bot-error"
            data-testid="local-bot-error"
            style={{ marginTop: 12, color: '#ef4444' }}
            role="alert"
          >
            {t('game.botEngineError', 'Bot engine could not start: {{msg}}', {
              msg: game.botError,
            })}
          </div>
        ) : game.status === 'active' && game.botThinking ? (
          <div
            className="local-bot-status"
            data-testid="local-bot-status-bot"
            style={{ marginTop: 12 }}
          >
            {t('game.botThinking', 'Bot is thinking…')}
          </div>
        ) : null
      }
    />
  );
}
