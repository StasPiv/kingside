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
// KS-3320 follow-up: piece-set из настроек.
import { useBoardTheme } from '../hooks/useBoardTheme';
import { ArchiveOtherGamesBlock } from '../components/archive/ArchiveOtherGamesBlock';
// KS-3258: forfeit-плашка для PGN'ов с [Termination "Unplayed"].
import { ForfeitPlaceholder } from '../components/ForfeitPlaceholder';
import { isForfeitGame } from '../utils/forfeitTermination';
// KS-3261: dedup-открытие через backend (POST /analyses {archiveGameId}).
import { openAnalysisFromPgn } from '../utils/openAnalysisFromPgn';

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
 * Имена игроков ведут на `/archive/players/:slug` (F3). `slug` берётся
 * напрямую из `ArchivePlayerInfo` — серверный slug из таблицы
 * `archive_players` (KS-2074). Если у игрока нет имени, бэк отдаёт
 * пустую строку — в этом случае ссылка не рендерится.
 */

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface ParsedMove {
  san: string;
  fenAfter: string;
}

/**
 * Извлекает значение PGN-тега вида `[Tag "value"]`. Возвращает строку
 * либо `null`, если тег отсутствует. Регэксп толерантен к whitespace
 * между ключом, кавычками и значением — встречается в реальных PGN-ах.
 */
function extractTag(pgn: string, tag: string): string | null {
  const re = new RegExp(`\\[\\s*${tag}\\s+"([^"]*)"\\s*\\]`, 'i');
  const m = re.exec(pgn);
  return m ? m[1] : null;
}

/**
 * Возвращает «тело» PGN — всё, что после блока тегов, очищенное от
 * `{ ... }` комментариев, `( ... )` вариантов, NAG-меток (`$N`), номеров
 * хода и финального результата. Полученная строка уже содержит только
 * SAN-токены, разделённые пробелами.
 */
function pgnBodyTokens(pgn: string): string[] {
  // Срезаем заголовочные теги: всё до первой пустой строки (между
  // блоком тегов и movetext'ом). Если пустой строки нет — берём
  // PGN целиком.
  const sepIdx = pgn.search(/\n\s*\n/);
  const body = sepIdx >= 0 ? pgn.slice(sepIdx) : pgn;

  // Удаляем `{ ... }` комментарии (включая многострочные).
  let cleaned = body.replace(/\{[^}]*\}/g, ' ');
  // Удаляем `( ... )` варианты — поддерживаем вложенность через цикл,
  // потому что обычный regex не съест nested группы.
  let prev: string;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/\([^()]*\)/g, ' ');
  } while (cleaned !== prev);
  // NAG-метки `$1`, `$12`.
  cleaned = cleaned.replace(/\$\d+/g, ' ');
  // Номера ходов: `1.`, `12.`, `1...` (после многоточия — чёрные).
  cleaned = cleaned.replace(/\d+\.(\.\.)?/g, ' ');

  return cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => t !== '1-0' && t !== '0-1' && t !== '1/2-1/2' && t !== '*');
}

/**
 * Парсит PGN в плоский список ходов с FEN после каждого. Если PGN
 * битый — возвращает `null` (страница покажет fallback).
 *
 * KS-2083: поддержка Chess960 / partial-setup PGN-ов. Если в шапке
 * есть `[FEN "..."]` (с `[SetUp "1"]` — каноническая пара по PGN-стандарту),
 * стартовая позиция — оттуда, а не дефолтная. `chess.js` v1.4
 * `loadPgn(...)` для PGN с `[Variant "Chess960"]` ведёт себя нестабильно
 * (иногда молча падает на хедерах), поэтому делаем парсинг тела PGN
 * вручную: чистим комментарии/варианты/номера, передаём SAN-токены в
 * `chess.move()` поштучно. На обычных ходах (которых в Chess960-партиях
 * подавляющее большинство) это надёжно работает; нестандартные кастлинги
 * Chess960 могут не распознаться, но это already-broken-edge-case и
 * лучше хотя бы показать частичный список ходов до точки сбоя, чем
 * пустую партию.
 */
function parsePgn(pgn: string): { moves: ParsedMove[]; initialFen: string } | null {
  if (!pgn || pgn.trim().length === 0) {
    return { moves: [], initialFen: STARTING_FEN };
  }
  try {
    const setUpTag = extractTag(pgn, 'SetUp');
    const fenTag = extractTag(pgn, 'FEN');
    // По PGN-стандарту начальная FEN считается активной только если
    // `[SetUp "1"]` явно стоит. На практике встречаются PGN-ы с FEN
    // без SetUp — на них тоже подменяем, иначе доска стояла бы в
    // дефолте (особенно критично для Chess960, где без FEN нет
    // никакого способа понять расстановку).
    const initialFen =
      fenTag && (setUpTag === '1' || setUpTag === null) ? fenTag : STARTING_FEN;

    const chess = new Chess(initialFen);
    const tokens = pgnBodyTokens(pgn);
    const moves: ParsedMove[] = [];
    for (const san of tokens) {
      const result = chess.move(san);
      if (!result) {
        // На нераспознанном ходе останавливаемся, но возвращаем то, что
        // успели распарсить — это лучше пустого списка.
        break;
      }
      moves.push({ san: result.san, fenAfter: chess.fen() });
    }
    return { moves, initialFen };
  } catch {
    return null;
  }
}

function formatResult(result: string | null): string {
  return result ?? '*';
}

function formatDate(date: string | null): string {
  if (!date) return '—';
  // ISO или PGN-формат `YYYY.MM.DD` — приводим точки к дефисам.
  return date.replace(/\./g, '-');
}

/**
 * KS-2375: внешняя обёртка-роут пересоздаёт `ArchiveGamePageInner`
 * при каждой смене `id` через `key={id}`. Это гарантирует, что React
 * выполнит unmount + mount, а не просто rerender — и любой
 * stale-state (game, ply, ArchiveOtherGamesBlock'овые items, локальные
 * caches) физически не выживает на route change. Ранее жалоба
 * пользователя «при открытии разных партий показывается одна и та же»
 * лечилась `useEffect[id]`, но на rapid-нав / медленном fetch'е могло
 * проскочить старое отображение, пока новый запрос ещё в полёте.
 * Полный mount на key — самый надёжный фикс: никакие use*-памяти не
 * переносятся между партиями.
 */
export function ArchiveGamePage() {
  const { id } = useParams<{ id: string }>();
  return <ArchiveGamePageInner key={id ?? '__none__'} />;
}

function ArchiveGamePageInner() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation('archive');
  const { customPieces } = useBoardTheme();

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

  // KS-2083: на ply=0 показываем initialFen из PGN (для Chess960 это
  // нестандартная стартовая позиция), а не хардкодед STARTING_FEN.
  const initialFen = parsed?.initialFen ?? STARTING_FEN;
  const currentFen =
    ply === 0 ? initialFen : moves[ply - 1]?.fenAfter ?? initialFen;

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
  // KS-3261: переключено с прямого `navigate('/analysis', state)` на
  // `openAnalysisFromPgn(archiveGameId)` — backend дедуплицирует и
  // возвращает существующий analysis-id вместо создания дубля + обновляет
  // lastOpenedAt → партия поднимается вверх «Моих анализов».
  const handleOpenInAnalysis = () => {
    if (!game) return;
    const whiteLabel = game.white.name ?? '—';
    const blackLabel = game.black.name ?? '—';
    void openAnalysisFromPgn(navigate, {
      pgn: game.pgn,
      title: `${whiteLabel} vs ${blackLabel}`,
      archiveGameId: game.id,
      state: {
        breadcrumbSection: t('gamePage.breadcrumb', 'Archive'),
        breadcrumbBackUrl: `/archive/games/${game.id}`,
      },
    });
  };

  const handleFindSimilar = () => {
    navigate(`/archive?fen=${encodeURIComponent(currentFen)}`);
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

  // KS-2075: серверный slug из ArchivePlayerInfo (KS-2074). Пустая
  // строка означает «у игрока нет имени» — ссылку не рендерим.
  const whiteSlug = game.white.slug || null;
  const blackSlug = game.black.slug || null;

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
                // KS-3320 follow-up: piece-set из настроек.
                ...(customPieces && { pieces: customPieces }),
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
              // KS-3258: forfeit-плашка для PGN'ов с [Termination "Unplayed"]
              // / Result != '*' без ходов. Иначе — старое сообщение
              // «No moves recorded for this game.».
              isForfeitGame(game?.pgn ?? '', 0) ? (
                <li
                  className="archive-game-page__moves-empty"
                  data-testid="archive-game-page-forfeit"
                >
                  <ForfeitPlaceholder pgn={game?.pgn ?? ''} />
                </li>
              ) : (
                <li className="archive-game-page__moves-empty" data-testid="archive-game-page-moves-empty">
                  {t('gamePage.noMoves', 'No moves recorded for this game.')}
                </li>
              )
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
