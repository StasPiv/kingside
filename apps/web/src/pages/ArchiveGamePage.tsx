import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  ArchiveGameDetail,
  ArchiveGamesByPositionItem,
} from '@kingside/shared';

import { archiveApi } from '../api/archive';
import { MemoChessboard } from '../components/MemoChessboard';
import { ArchiveOtherGamesBlock } from '../components/archive/ArchiveOtherGamesBlock';

/**
 * KS-2070 (F4 / ADR-033 §5.2): страница одной архивной партии.
 *
 * Поведение:
 *  - На mount: `archiveApi.getArchiveGameById(id)` → `ArchiveGameDetail`.
 *  - PGN парсится через `chess.js`. Каждому ходу сопоставляется FEN
 *    после хода — этим управляется доска и MoveList.
 *  - Текущий ply хранится локально (0 = стартовая позиция, N = после
 *    N-го полу-хода). Кнопки навигации: «⏮ ⟨ ⟩ ⏭».
 *  - «Open in analysis» — паттерн `WorkshopPgnList` (KS-2066): передаём
 *    PGN/title через `location.state` + breadcrumb обратно сюда.
 *  - «Find similar» — `/archive/games?fen=<currentFen>` (F2-страница
 *    metadata-фильтров возьмёт fen и применит фильтр).
 *  - «Copy PGN» — `navigator.clipboard.writeText`.
 *  - Lazy-блок «Other games with this position» — отдельный компонент
 *    `<ArchiveOtherGamesBlock>` (см. ADR-033 §9.4).
 *
 * 404: если game не найден — отдельный экран с возвратом на `/archive`.
 *
 * Имена игроков ведут на `/archive/players/:slug` (F3). `slug` в
 * `ArchivePlayerInfo` отсутствует на этом контракте, поэтому строим его
 * на клиенте из `name` через `slugify` (минимальный slug, см. ADR-033
 * §4.4 — фактический slug на бэке резолвится отдельно, но для
 * deep-link'а до F3 этого достаточно).
 */

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface ParsedMove {
  san: string;
  fenAfter: string;
}

/**
 * Парсит PGN в плоский список ходов с FEN после каждого. Если PGN
 * битый — возвращает `null` (страница покажет fallback).
 */
function parsePgn(pgn: string): { moves: ParsedMove[]; initialFen: string } | null {
  if (!pgn || pgn.trim().length === 0) {
    return { moves: [], initialFen: STARTING_FEN };
  }
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const verbose = chess.history({ verbose: true });
    // Реплей с нуля, чтобы получить FEN ПОСЛЕ каждого хода (history()
    // возвращает только метаданные ходов, без FEN-снапшотов).
    const replay = new Chess();
    const moves: ParsedMove[] = [];
    for (const m of verbose) {
      replay.move({ from: m.from, to: m.to, promotion: m.promotion });
      moves.push({ san: m.san, fenAfter: replay.fen() });
    }
    return { moves, initialFen: STARTING_FEN };
  } catch {
    return null;
  }
}

function slugifyPlayerName(name: string | null | undefined): string | null {
  if (!name) return null;
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : null;
}

function formatResult(result: string | null): string {
  return result ?? '*';
}

function formatDate(date: string | null): string {
  if (!date) return '—';
  // ISO или PGN-формат `YYYY.MM.DD` — приводим точки к дефисам.
  return date.replace(/\./g, '-');
}

export function ArchiveGamePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation('archive');

  const [game, setGame] = useState<ArchiveGameDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'not_found' | 'load_error' | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  // ─── Загрузка ────────────────────────────────────────────────────
  useEffect(() => {
    if (!id) {
      setError('not_found');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setGame(null);
    archiveApi
      .getArchiveGameById(id)
      .then((res) => {
        if (cancelled) return;
        setGame(res);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        // archive-service возвращает 404 на отсутствующий id; если в
        // будущем появится отдельный errorCode — можно его проверять.
        // Сейчас по тексту ошибки определяем «not found» vs «другая
        // ошибка»: 404 содержит status `404` в сообщении-фолбэке.
        const isNotFound = /\b404\b|not\s*found/i.test(e.message);
        setError(isNotFound ? 'not_found' : 'load_error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // ─── Парсинг PGN ─────────────────────────────────────────────────
  const parsed = useMemo(() => (game ? parsePgn(game.pgn) : null), [game]);
  const moves: ParsedMove[] = parsed?.moves ?? [];

  const [ply, setPly] = useState(0);
  // При смене партии — сбрасываем ply на 0 (старт).
  const lastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (game && lastIdRef.current !== game.id) {
      setPly(0);
      lastIdRef.current = game.id;
    }
  }, [game]);

  const currentFen =
    ply === 0 ? STARTING_FEN : moves[ply - 1]?.fenAfter ?? STARTING_FEN;

  const goTo = useCallback(
    (target: number) => {
      const clamped = Math.max(0, Math.min(target, moves.length));
      setPly(clamped);
    },
    [moves.length],
  );

  // Клавиатура — стрелки листают ходы, как в /analysis. Не перехватываем
  // в input/textarea/contenteditable.
  useEffect(() => {
    if (moves.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if ((target as HTMLElement).isContentEditable) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goTo(ply - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goTo(ply + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ply, goTo, moves.length]);

  // ─── Actions ─────────────────────────────────────────────────────
  const handleOpenInAnalysis = () => {
    if (!game) return;
    const whiteLabel = game.white.name ?? '—';
    const blackLabel = game.black.name ?? '—';
    navigate('/analysis', {
      state: {
        pgn: game.pgn,
        title: `${whiteLabel} vs ${blackLabel}`,
        breadcrumbSection: t('gamePage.breadcrumb', 'Archive'),
        breadcrumbBackUrl: `/archive/games/${game.id}`,
      },
    });
  };

  const handleFindSimilar = () => {
    navigate(`/archive/games?fen=${encodeURIComponent(currentFen)}`);
  };

  const handleCopyPgn = async () => {
    if (!game) return;
    try {
      await navigator.clipboard.writeText(game.pgn);
      setCopyMsg(t('gamePage.actions.copied', 'PGN copied'));
    } catch {
      setCopyMsg(t('gamePage.actions.copyError', 'Could not copy PGN'));
    }
    // Скрываем сообщение через 1.8 секунды.
    window.setTimeout(() => setCopyMsg(null), 1800);
  };

  const handleSelectOtherGame = useCallback(
    (item: ArchiveGamesByPositionItem) => {
      navigate(`/archive/games/${item.id}`);
    },
    [navigate],
  );

  // ─── Рендер ─────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="archive-page archive-game-page" data-testid="archive-game-page" data-state="loading">
        <p>{t('gamePage.loading', 'Loading…')}</p>
      </div>
    );
  }

  if (error === 'not_found') {
    return (
      <div className="archive-page archive-game-page" data-testid="archive-game-page" data-state="not-found">
        <h1>{t('gamePage.notFound.title', 'Game not found')}</h1>
        <p>
          {t(
            'gamePage.notFound.description',
            'The requested game does not exist or has been removed.',
          )}
        </p>
        <Link className="archive-game-page__back" to="/archive" data-testid="archive-game-page-back">
          ← {t('gamePage.notFound.backToArchive', 'Back to archive')}
        </Link>
      </div>
    );
  }

  if (error === 'load_error' || !game) {
    return (
      <div className="archive-page archive-game-page" data-testid="archive-game-page" data-state="error">
        <p>{t('gamePage.loadError', 'Failed to load the game. Try refreshing the page.')}</p>
      </div>
    );
  }

  const whiteSlug = slugifyPlayerName(game.white.name);
  const blackSlug = slugifyPlayerName(game.black.name);

  return (
    <div className="archive-page archive-game-page" data-testid="archive-game-page" data-state="ready">
      <header className="archive-game-page__header">
        <h1 className="archive-game-page__title">
          {t('gamePage.title', 'Archive game')}
        </h1>
        <Link to="/archive" className="archive-game-page__back" data-testid="archive-game-page-back">
          ← {t('gamePage.notFound.backToArchive', 'Back to archive')}
        </Link>
      </header>

      <div className="archive-game-page__body">
        {/* Левая колонка — доска + кнопки навигации по ходам. */}
        <section className="archive-game-page__board-col">
          <div
            className="archive-game-page__board"
            data-testid="archive-game-page-board"
            data-fen={currentFen}
          >
            <MemoChessboard
              options={{
                position: currentFen,
                allowDragging: false,
                animationDurationInMs: 0,
              }}
            />
          </div>
          <div className="archive-game-page__nav" role="group" aria-label={t('gamePage.moveNavLabel', 'Move navigation')}>
            <button
              type="button"
              data-testid="archive-game-page-first"
              onClick={() => goTo(0)}
              disabled={ply === 0}
              aria-label={t('gamePage.nav.first', 'First move')}
            >
              ⏮
            </button>
            <button
              type="button"
              data-testid="archive-game-page-prev"
              onClick={() => goTo(ply - 1)}
              disabled={ply === 0}
              aria-label={t('gamePage.nav.prev', 'Previous move')}
            >
              ◀
            </button>
            <span className="archive-game-page__counter" data-testid="archive-game-page-counter">
              {ply}/{moves.length}
            </span>
            <button
              type="button"
              data-testid="archive-game-page-next"
              onClick={() => goTo(ply + 1)}
              disabled={ply >= moves.length}
              aria-label={t('gamePage.nav.next', 'Next move')}
            >
              ▶
            </button>
            <button
              type="button"
              data-testid="archive-game-page-last"
              onClick={() => goTo(moves.length)}
              disabled={ply >= moves.length}
              aria-label={t('gamePage.nav.last', 'Last move')}
            >
              ⏭
            </button>
          </div>
        </section>

        {/* Правая колонка — метаданные, MoveList, кнопки, lazy-блок. */}
        <section className="archive-game-page__side-col">
          <dl className="archive-game-page__meta" data-testid="archive-game-page-meta">
            <div className="archive-game-page__meta-row">
              <dt>{t('gamePage.meta.white', 'White')}</dt>
              <dd>
                {whiteSlug ? (
                  <Link
                    to={`/archive/players/${whiteSlug}`}
                    data-testid="archive-game-page-white-link"
                  >
                    {game.white.name}
                  </Link>
                ) : (
                  game.white.name ?? '—'
                )}
                {game.white.elo != null && (
                  <span className="archive-game-page__elo"> ({game.white.elo})</span>
                )}
              </dd>
            </div>
            <div className="archive-game-page__meta-row">
              <dt>{t('gamePage.meta.black', 'Black')}</dt>
              <dd>
                {blackSlug ? (
                  <Link
                    to={`/archive/players/${blackSlug}`}
                    data-testid="archive-game-page-black-link"
                  >
                    {game.black.name}
                  </Link>
                ) : (
                  game.black.name ?? '—'
                )}
                {game.black.elo != null && (
                  <span className="archive-game-page__elo"> ({game.black.elo})</span>
                )}
              </dd>
            </div>
            <div className="archive-game-page__meta-row">
              <dt>{t('gamePage.meta.result', 'Result')}</dt>
              <dd data-testid="archive-game-page-result">{formatResult(game.result)}</dd>
            </div>
            {game.event && (
              <div className="archive-game-page__meta-row">
                <dt>{t('gamePage.meta.event', 'Event')}</dt>
                <dd>{game.event}</dd>
              </div>
            )}
            {game.round && (
              <div className="archive-game-page__meta-row">
                <dt>{t('gamePage.meta.round', 'Round')}</dt>
                <dd>{game.round}</dd>
              </div>
            )}
            {game.date && (
              <div className="archive-game-page__meta-row">
                <dt>{t('gamePage.meta.date', 'Date')}</dt>
                <dd>{formatDate(game.date)}</dd>
              </div>
            )}
            {game.eco && (
              <div className="archive-game-page__meta-row">
                <dt>{t('gamePage.meta.eco', 'ECO')}</dt>
                <dd>{game.eco}</dd>
              </div>
            )}
            {game.opening && (
              <div className="archive-game-page__meta-row">
                <dt>{t('gamePage.meta.opening', 'Opening')}</dt>
                <dd>{game.opening}</dd>
              </div>
            )}
          </dl>

          {/* Компактный MoveList — переиспользуем ReviewMoveList не получается
              без useReviewState; локальный компактный список ходов справится
              с задачей «список SAN-ходов с подсветкой текущего ply». */}
          <ol className="archive-game-page__moves" data-testid="archive-game-page-moves">
            {moves.length === 0 && (
              <li className="archive-game-page__moves-empty" data-testid="archive-game-page-moves-empty">
                {t('gamePage.noMoves', 'No moves recorded for this game.')}
              </li>
            )}
            {moves.map((m, idx) => {
              const moveNumber = Math.floor(idx / 2) + 1;
              const isWhite = idx % 2 === 0;
              const oneBased = idx + 1;
              return (
                <li
                  key={`${idx}-${m.san}`}
                  className={`archive-game-page__move${ply === oneBased ? ' archive-game-page__move--current' : ''}`}
                >
                  {isWhite && (
                    <span className="archive-game-page__move-number">{moveNumber}.</span>
                  )}
                  <button
                    type="button"
                    className="archive-game-page__move-btn"
                    data-testid={`archive-game-page-move-${oneBased}`}
                    aria-current={ply === oneBased ? 'true' : undefined}
                    onClick={() => goTo(oneBased)}
                  >
                    {m.san}
                  </button>
                </li>
              );
            })}
          </ol>

          <div
            className="archive-game-page__actions"
            data-testid="archive-game-page-actions"
          >
            <button
              type="button"
              className="archive-game-page__action archive-game-page__action--primary"
              data-testid="archive-game-page-open-in-analysis"
              onClick={handleOpenInAnalysis}
            >
              {t('gamePage.actions.openInAnalysis', 'Open in analysis')}
            </button>
            <button
              type="button"
              className="archive-game-page__action"
              data-testid="archive-game-page-find-similar"
              onClick={handleFindSimilar}
            >
              {t('gamePage.actions.findSimilar', 'Find similar')}
            </button>
            <button
              type="button"
              className="archive-game-page__action"
              data-testid="archive-game-page-copy-pgn"
              onClick={handleCopyPgn}
            >
              {t('gamePage.actions.copyPgn', 'Copy PGN')}
            </button>
            {copyMsg && (
              <span
                className="archive-game-page__action-msg"
                data-testid="archive-game-page-copy-msg"
                role="status"
              >
                {copyMsg}
              </span>
            )}
          </div>

          <ArchiveOtherGamesBlock
            positionFen={currentFen}
            excludeGameId={game.id}
            onSelectGame={handleSelectOtherGame}
          />
        </section>
      </div>
    </div>
  );
}
