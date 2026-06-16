/**
 * KS-4256 dev-only песочница: статически воспроизводит layout
 * страницы `/game/<id>` с ботом (player-bar сверху, доска,
 * player-bar снизу, sidebar справа, bot-banner) для приёмочных
 * скриншотов размера доски и пропорций.
 *
 * Доступ: `/__dev/game-layout`. Логика игры не задействована —
 * стоит статическая стартовая позиция, размер доски берётся из
 * `useResponsiveBoardSize` (тот же хук, что в `GameShell`).
 */
import { useState } from 'react';
import { Chessboard } from 'react-chessboard';

import { useResponsiveBoardSize } from '../../hooks/useResponsiveBoardSize';

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

type Theme = 'dark' | 'light';

export default function GameLayoutPreviewPage() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [showBotBanner, setShowBotBanner] = useState(true);
  const boardWidth = useResponsiveBoardSize();

  return (
    <div data-theme={theme} className="game-page" style={{ height: '100dvh' }}>
      {/* Превью-toolbar в углу — не из боевой страницы, нужен только тут. */}
      <div
        style={{
          position: 'fixed',
          top: 56,
          left: 110,
          zIndex: 10,
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'center',
          padding: '4px 10px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-mid)',
          borderRadius: 8,
          color: 'var(--text-primary)',
          fontSize: 12,
        }}
      >
        <span style={{ color: 'var(--text-muted)' }}>
          KS-4256 · board={boardWidth}px · theme:
        </span>
        {(['dark', 'light'] as Theme[]).map((tt) => (
          <button
            key={tt}
            type="button"
            onClick={() => setTheme(tt)}
            style={{
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid var(--border-mid)',
              background:
                theme === tt ? 'var(--accent-primary)' : 'transparent',
              color:
                theme === tt ? 'var(--text-on-accent)' : 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            {tt}
          </button>
        ))}
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            color: 'var(--text-secondary)',
          }}
        >
          <input
            type="checkbox"
            checked={showBotBanner}
            onChange={(e) => setShowBotBanner(e.target.checked)}
          />
          bot banner
        </label>
      </div>

      <div className="game-board-area">
        {showBotBanner && (
          <div className="bot-fallback-banner">
            <span>
              Вы играете с ботом. Пока мало игроков онлайн, бот заменяет
              соперника.
            </span>
            <button type="button">&times;</button>
          </div>
        )}

        <div className="player-info opponent-info">
          <span className="color-indicator black" />
          <span className="player-name">Stockfish Bot (Lv. 3)</span>
          <span className="clock">4:39</span>
        </div>

        <div
          className="board-container"
          style={
            boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined
          }
        >
          <Chessboard
            options={{
              position: STARTING_FEN,
              allowDragging: false,
              animationDurationInMs: 0,
              showNotation: true,
            }}
          />
        </div>

        <div className="player-info self-info">
          <span className="color-indicator white" />
          <span className="player-name">Stanislav</span>
          <span className="clock">4:52</span>
        </div>
      </div>

      <div className="game-sidebar">
        <div className="game-actions-top">
          <button type="button" className="mute-toggle" aria-label="mute">
            🔊
          </button>
        </div>
        <div className="move-list">
          <h3>Ходы</h3>
          <div className="game-moves-inline">
            <span className="move-number">1.</span>{' '}
            <span className="game-move-item">e4</span>{' '}
            <span className="game-move-item">d5</span>{' '}
            <span className="move-number">2.</span>{' '}
            <span className="game-move-item">exd5</span>{' '}
            <span className="game-move-item">Qxd5</span>{' '}
            <span className="move-number">3.</span>{' '}
            <span className="game-move-item">Nc3</span>{' '}
            <span className="game-move-item">Qd8</span>{' '}
            <span className="move-number">4.</span>{' '}
            <span className="game-move-item">d4</span>{' '}
            <span className="game-move-item current">c6</span>
          </div>
        </div>
        <div className="game-actions">
          <button type="button">Сдаться</button>
          <button type="button">Ничья</button>
        </div>
      </div>
    </div>
  );
}
