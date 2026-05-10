import { useTranslation } from 'react-i18next';

/**
 * KS-2707. Лента последних ходов раунда трансляции. Презентационный
 * компонент: feed-список владеет родитель (`BroadcastRoundPage`),
 * наполняет его в `handleMove` через `useBroadcastSocket`. Здесь только
 * рендерим строки и эмитим `onItemClick(gameKey)` для скролла к
 * соответствующей мини-доске.
 *
 * Desktop — правая боковая панель (CSS-сетка 1fr × 280px).
 * Mobile — `<details>`-accordion внизу страницы (раскрывается тапом).
 *
 * Лента не персистится: при reload пустая, история берётся только
 * из live-WS. Размер ограничен в родителе (max 50).
 */

export interface BroadcastFeedItem {
  /** Стабильный ключ партии (`whitePlayer|blackPlayer`). */
  gameKey: string;
  whitePlayer: string;
  blackPlayer: string;
  /** Чей ход был сделан. */
  side: 'white' | 'black';
  /** Номер хода в партии (1-based, как в PGN). */
  moveNumber: number;
  /** SAN если удалось получить, иначе UCI как fallback. */
  notation: string;
  /** Локальное время `Date.now()` события. */
  ts: number;
}

export interface BroadcastLiveFeedProps {
  items: BroadcastFeedItem[];
  onItemClick?: (gameKey: string) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function shortName(full: string): string {
  // «Last, First» → «Last»; «First Last» → «Last»; иначе как есть.
  const trimmed = full.trim();
  if (trimmed.includes(',')) return trimmed.split(',')[0].trim();
  const parts = trimmed.split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : trimmed;
}

export function BroadcastLiveFeed({ items, onItemClick }: BroadcastLiveFeedProps) {
  const { t } = useTranslation();

  const renderRow = (item: BroadcastFeedItem, idx: number) => {
    const moveLabel =
      item.side === 'white'
        ? `${item.moveNumber}. ${item.notation}`
        : `${item.moveNumber}… ${item.notation}`;
    const players = `${shortName(item.whitePlayer)} — ${shortName(item.blackPlayer)}`;
    return (
      <li
        key={`${item.ts}-${idx}`}
        className="broadcast-feed__row"
        data-testid="broadcast-feed-row"
      >
        <button
          type="button"
          className="broadcast-feed__row-btn"
          onClick={() => onItemClick?.(item.gameKey)}
          title={`${players} — ${moveLabel}`}
        >
          <span className="broadcast-feed__row-time">{formatTime(item.ts)}</span>
          <span
            className={`broadcast-feed__row-dot broadcast-feed__row-dot--${item.side}`}
            aria-hidden="true"
          />
          <span className="broadcast-feed__row-side-label" aria-hidden="true">
            {item.side === 'white' ? 'W' : 'B'}
          </span>
          <span className="broadcast-feed__row-move">{moveLabel}</span>
          <span className="broadcast-feed__row-players">{players}</span>
        </button>
      </li>
    );
  };

  return (
    <>
      {/* Desktop: статичная правая колонка. */}
      <aside
        className="broadcast-feed broadcast-feed--desktop"
        data-testid="broadcast-feed"
        aria-label={t('broadcastRound.feed.title', 'Live moves')}
      >
        <h3 className="broadcast-feed__title">
          {t('broadcastRound.feed.title', 'Live moves')}
        </h3>
        {items.length === 0 ? (
          <p
            className="broadcast-feed__empty"
            data-testid="broadcast-feed-empty"
          >
            {t('broadcastRound.feed.empty', 'Waiting for the first move…')}
          </p>
        ) : (
          <ul className="broadcast-feed__list">{items.map(renderRow)}</ul>
        )}
      </aside>
      {/* Mobile: accordion внизу страницы. */}
      <details
        className="broadcast-feed broadcast-feed--mobile"
        data-testid="broadcast-feed-mobile"
      >
        <summary className="broadcast-feed__summary">
          {t('broadcastRound.feed.summaryWithCount', 'Live moves ({{count}})', {
            count: items.length,
          })}
        </summary>
        {items.length === 0 ? (
          <p className="broadcast-feed__empty">
            {t('broadcastRound.feed.empty', 'Waiting for the first move…')}
          </p>
        ) : (
          <ul className="broadcast-feed__list">{items.map(renderRow)}</ul>
        )}
      </details>
    </>
  );
}
