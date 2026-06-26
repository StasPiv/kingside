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
import { BotEngineDebugPanel } from '../components/BotEngineDebugPanel';
import { PageSeo } from '../components/seo/PageSeo';
import { PlayLocalBotSeoSection } from '../components/seo/sections/PlayLocalBotSeoSection';
import {
  useLocalBotGame,
  type LocalBotTimeControl,
} from '../hooks/useLocalBotGame';
// KS-4655 / ADR-144 §3.4. Полный переезд local-bot часов на тот же
// pipeline, что и live (KS-4652): `useGameClockDisplay` экстраполирует
// от мс-snapshot'а через `performance.now()` и сам выбирает
// частоту (250 мс / rAF) и формат (normal/tenths/hundredths).
import { useGameClockDisplay } from '../hooks/useGameClockDisplay';
import { useClockTickScheduler } from '../hooks/useClockTickScheduler';

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

  // KS-4655 / ADR-144 §3.4. Активная сторона + initialMs для
  // экстраполяции часов. В `noClock` режиме `initialMs=null`
  // (`useGameClockDisplay` всё равно рендерит статичные мс, но в
  // GameShell блок часов скрыт через `hideClocks`).
  const activeColor: 'white' | 'black' | null =
    game.status === 'active'
      ? game.chess.turn() === 'w'
        ? 'white'
        : 'black'
      : null;
  const clockDisplay = useGameClockDisplay({
    whiteMs: game.clocksMs.whiteMs,
    blackMs: game.clocksMs.blackMs,
    activeColor,
    snapshotAt: game.clocksMs.snapshotAt,
    initialMs: game.noClock ? null : game.initialMs,
    isFinished: game.status === 'finished',
  });

  // KS-4654 / ADR-144 §3.6. Метроном-тик на собственных часах.
  // Тикает только когда `isSelfActive=true` и urgency != 'normal'.
  const isSelfActive = activeColor === game.playerColor;
  const selfUrgency =
    game.playerColor === 'white'
      ? clockDisplay.whiteUrgency
      : clockDisplay.blackUrgency;
  useClockTickScheduler({ urgency: selfUrgency, isSelfActive });

  return (
    <>
      {/* KS-4320: per-page SEO + JSON-LD. */}
      <PageSeo
        ns="playLocalBot"
        path="/play/local-bot"
        ogImage="/og/play-bot.png"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'WebApplication',
          name: 'Kingside Play vs Bot',
          applicationCategory: 'GameApplication',
          operatingSystem: 'Web',
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        }}
      />
      {/* KS-4308: отладочная панель `BotEngineDebugPanel` — рендерится
          поверх верха страницы через `position: fixed`. Видна только
          пользователю `Stanislav` (гейт по `useAuth().user.username`
          внутри компонента) — у всех остальных возвращает `null`. */}
      <BotEngineDebugPanel />
      <GameShell
      chess={game.chess}
      fen={game.fen}
      moves={game.moves}
      /* KS-4655: пропсы часов берутся прямо из `useGameClockDisplay`
         (как в live). Локальной sec↔ms-конвертации больше нет. */
      whiteClockMs={clockDisplay.whiteDisplayMs}
      blackClockMs={clockDisplay.blackDisplayMs}
      whiteClockMode={clockDisplay.whiteMode}
      blackClockMode={clockDisplay.blackMode}
      whiteClockUrgency={clockDisplay.whiteUrgency}
      blackClockUrgency={clockDisplay.blackUrgency}
      status={game.status}
      result={game.result}
      playerColor={game.playerColor}
      players={game.players}
      onMove={game.onMove}
      /* KS-4669. Включаем предход в партиях с ботом: и перетаскивание,
         и тап-тап (KS-4668). Сама логика применения предхода после
         хода бота живёт в `GameShell` (useEffect, отслеживающий смену
         `fen` и `chess.turn()` — общий для live и local-bot). Бот
         делает ход → `useLocalBotGame` обновляет fen → useEffect в
         GameShell видит, что снова наш ход, и применяет
         `pendingPremove` через `onMove(from, to, promotion)`. Если
         premove на новой позиции нелегален — `useLocalBotGame.onMove`
         вернёт `false`, premove просто отбросится. */
      enablePremove={true}
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
      hideClocks={game.noClock}
      belowBoardBlock={
        // KS-4151: блок отрисовывается ВСЕГДА с фиксированной высотой.
        // Раньше div появлялся/исчезал при botThinking → менялось число
        // детей `.game-board-area` (flex column, justify-content: center)
        // и доска визуально смещалась вверх/вниз на каждом ходе бота —
        // отсюда «дрожание». Сейчас высота 24px зарезервирована всегда,
        // меняется только текстовое содержимое — без layout shift.
        // KS-4303: при ошибке инициализации движка показываем сообщение
        // и кнопку «Запустить движок ещё раз». До правки молчаливый
        // ступор: `botError` ставился, но retry не было — пользователь
        // не понимал, что движок умер, и игра «работала через раз».
        <div
          className="local-bot-below"
          style={{
            marginTop: 12,
            minHeight: 24,
            lineHeight: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            width: '100%',
            flexWrap: 'wrap',
          }}
        >
          {game.engineError ? (
            <>
              <span
                className="local-bot-error"
                data-testid="local-bot-engine-error"
                style={{ color: '#ef4444' }}
                role="alert"
              >
                {t(
                  'game.botEngineFailed',
                  'Could not start the bot engine.',
                )}
              </span>
              <button
                type="button"
                onClick={game.retryEngine}
                data-testid="local-bot-engine-retry"
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--border-mid)',
                  background: 'var(--bg-elevated, var(--c-16213e))',
                  color: 'var(--text-primary, #fff)',
                  cursor: 'pointer',
                  minHeight: 28,
                }}
              >
                {t('game.botEngineRetry', 'Try again')}
              </button>
            </>
          ) : game.botError ? (
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
    {/* KS-4320: SEO-блок «Играть с ботом онлайн» под игровой
        областью. Попадает в prerender'д HTML для индексации. */}
    <PlayLocalBotSeoSection />
    </>
  );
}
