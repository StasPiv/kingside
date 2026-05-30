/**
 * KS-3443 (ADR-088 §11 F2). Финал-экран blind-board: streak текущей
 * сессии + личный рекорд + лидерборд (топ best-streak).
 * KS-3453: dead-end больше не существует — сервер при отсутствии хода
 * у целевой фигуры берёт другую из 5; сессия завершается только
 * wrong-answer или abandoned. Бейдж/текст «загнал компа в угол» и
 * ветка `reason === 'dead-end'` удалены.
 *
 * Шаблон взят с Puzzle Rush result-screen + leaderboard, упрощён под
 * специфику blind-board (нет timeMode-вкладок — таблица одна).
 *
 * Раскрытие полной расстановки (revealedPosition) тоже рисуется здесь:
 * собирается FEN из BlindBoardPiece[] (см. piecesToFen) и подаётся в
 * MemoChessboard статически.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BlindBoardLeaderboardEntry,
  BlindBoardPiece,
  BlindBoardSessionDto,
  SubmitBlindBoardAnswerResponse,
} from '@kingside/shared';

import { MemoChessboard } from '../MemoChessboard';
import { useAuth } from '../../context/AuthContext';
import { blindBoardApi } from '../../api/blindBoardApi';

const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1';

/** FEN из набора фигур (в M1 цвет не различаем — все upper-case). */
export function piecesToFen(pieces: BlindBoardPiece[]): string {
  if (pieces.length === 0) return EMPTY_FEN;
  const grid: string[][] = Array.from({ length: 8 }, () =>
    Array.from({ length: 8 }, () => ''),
  );
  for (const p of pieces) {
    const file = p.square.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = parseInt(p.square[1], 10) - 1;
    const row = 7 - rank;
    grid[row][file] = p.type;
  }
  const rows = grid.map((row) => {
    let s = '';
    let empty = 0;
    for (const cell of row) {
      if (cell === '') {
        empty += 1;
      } else {
        if (empty > 0) {
          s += String(empty);
          empty = 0;
        }
        s += cell;
      }
    }
    if (empty > 0) s += String(empty);
    return s;
  });
  return `${rows.join('/')} w - - 0 1`;
}

export interface BlindBoardFinalScreenProps {
  session: BlindBoardSessionDto;
  lastAnswer: SubmitBlindBoardAnswerResponse | null;
  /** Колбэк «играть ещё». */
  onPlayAgain?: () => void;
  /** DI для тестов — позволяет подменить blindBoardApi. */
  api?: Pick<typeof blindBoardApi, 'getLeaderboard'>;
}

export function BlindBoardFinalScreen({
  session,
  lastAnswer,
  onPlayAgain,
  api = blindBoardApi,
}: BlindBoardFinalScreenProps) {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [entries, setEntries] = useState<BlindBoardLeaderboardEntry[] | null>(
    null,
  );
  const [lbError, setLbError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setLbError(false);
    void (async () => {
      try {
        const res = await api.getLeaderboard();
        if (!cancelled) setEntries(res.entries ?? []);
      } catch {
        if (!cancelled) setLbError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // KS-3443: личный рекорд = max(bestStreak сессии, моя запись в
  // лидерборде, если она есть). До загрузки — показываем сессионный.
  const personalBest = useMemo(() => {
    const sessionBest = session.bestStreak;
    if (!user || !entries) return sessionBest;
    const mine = entries.find((e) => e.userId === user.id);
    return Math.max(sessionBest, mine?.bestStreak ?? 0);
  }, [session.bestStreak, entries, user]);

  const isPersonalRecord =
    !!user && entries !== null && session.bestStreak > 0
      ? !entries.some(
          (e) => e.userId === user.id && e.bestStreak >= session.bestStreak,
        )
      : false;

  const revealedFen = useMemo(() => {
    if (!lastAnswer?.revealedPosition) return EMPTY_FEN;
    return piecesToFen(lastAnswer.revealedPosition);
  }, [lastAnswer]);

  // KS-3453: оставлены только wrong-answer и abandoned (dead-end
  // не существует — backend всегда находит ход в одной из 5 фигур).
  const reason = session.finishReason;
  const reasonText =
    reason === 'wrong-answer'
      ? t('blindBoard.final.wrongAnswer', 'Wrong answer — game over.')
      : t('blindBoard.final.abandoned', 'Session finished.');

  return (
    <div
      className="blind-board-final"
      data-testid="blind-board-final"
      data-finish-reason={reason ?? ''}
    >
      <h2 data-testid="blind-board-final-title">
        {t('blindBoard.final.title', 'Game finished')}
      </h2>

      {/* KS-3453: бейдж dead-end удалён — сессия больше не может
          закончиться по «угол», backend всегда находит ход. */}

      <p
        className="blind-board-final__reason"
        data-testid="blind-board-final-reason"
      >
        {reasonText}
      </p>

      <div
        className="blind-board-final__board"
        data-testid="blind-board-final-board"
      >
        <MemoChessboard
          options={{
            position: revealedFen,
            boardOrientation: 'white',
            allowDragging: false,
            showNotation: true,
            animationDurationInMs: 0,
          }}
        />
      </div>

      {lastAnswer?.expectedSquare && lastAnswer.expectedPieceType && (
        <p
          className="blind-board-final__expected"
          data-testid="blind-board-final-expected"
        >
          {t('blindBoard.final.expected', 'Expected')}:{' '}
          <strong>
            {lastAnswer.expectedPieceType}
            {lastAnswer.expectedSquare}
          </strong>
        </p>
      )}

      <div
        className="blind-board-final__stats"
        data-testid="blind-board-final-stats"
      >
        <div
          className="blind-board-final__stat blind-board-final__stat--streak"
          data-testid="blind-board-final-streak-box"
        >
          <span
            className="blind-board-final__stat-value"
            data-testid="blind-board-final-streak"
          >
            {session.streak}
            {/* KS-3489 (V2 §15 F2): «28 · L3» — достигнутый уровень
                в текущей сессии. Поле гарантированно есть в DTO V2. */}
            <span
              className="blind-board-final__stat-level"
              data-testid="blind-board-final-streak-level"
            >
              {' '}· L{session.level}
            </span>
          </span>
          <span className="blind-board-final__stat-label">
            {t('blindBoard.final.streak', 'Streak')}
          </span>
        </div>
        <div
          className="blind-board-final__stat blind-board-final__stat--personal-best"
          data-testid="blind-board-final-personal-best-box"
          data-is-record={isPersonalRecord ? 'true' : 'false'}
        >
          <span
            className="blind-board-final__stat-value"
            data-testid="blind-board-final-personal-best"
          >
            {personalBest}
          </span>
          <span className="blind-board-final__stat-label">
            {t('blindBoard.final.personalBest', 'Personal best')}
          </span>
          {isPersonalRecord && (
            <span
              className="blind-board-final__new-record"
              data-testid="blind-board-final-new-record"
            >
              {t('blindBoard.final.newRecord', 'New record!')}
            </span>
          )}
        </div>
      </div>

      {/* — Лидерборд: топ best-streak'ов — */}
      <section
        className="blind-board-final__leaderboard"
        data-testid="blind-board-final-leaderboard"
      >
        <h3 className="blind-board-final__leaderboard-title">
          {t('blindBoard.final.leaderboardTitle', 'Top streaks')}
        </h3>
        {entries === null && !lbError && (
          <p
            className="blind-board-final__leaderboard-loading"
            data-testid="blind-board-final-leaderboard-loading"
          >
            {t('common.loading', 'Loading…')}
          </p>
        )}
        {lbError && (
          <p
            className="blind-board-final__leaderboard-error"
            data-testid="blind-board-final-leaderboard-error"
          >
            {t(
              'blindBoard.final.leaderboardError',
              'Could not load the leaderboard.',
            )}
          </p>
        )}
        {entries !== null && !lbError && entries.length === 0 && (
          <p
            className="blind-board-final__leaderboard-empty"
            data-testid="blind-board-final-leaderboard-empty"
          >
            {t('blindBoard.final.leaderboardEmpty', 'No entries yet.')}
          </p>
        )}
        {entries !== null && entries.length > 0 && (
          <ol
            className="blind-board-final__leaderboard-list"
            data-testid="blind-board-final-leaderboard-list"
          >
            {entries.map((e, i) => {
              const mine = !!user && e.userId === user.id;
              return (
                <li
                  key={`${e.userId}-${e.achievedAt}`}
                  className={`blind-board-final__leaderboard-row${
                    mine ? ' blind-board-final__leaderboard-row--me' : ''
                  }`}
                  data-testid={`blind-board-final-leaderboard-row-${i + 1}`}
                  data-mine={mine ? 'true' : 'false'}
                >
                  <span className="blind-board-final__leaderboard-rank">
                    {i + 1}
                  </span>
                  <span className="blind-board-final__leaderboard-name">
                    {e.username}
                  </span>
                  <span
                    className="blind-board-final__leaderboard-streak"
                    data-testid={`blind-board-final-leaderboard-streak-${i + 1}`}
                  >
                    {e.bestStreak}
                    {/* KS-3489 (V2 §15 F2): «28 · L3» — maxLevel
                        backend считает как floor(bestStreak/10)+1
                        (derived). Если backend ещё не V2 — поле
                        отсутствует, рендер плавно деградирует. */}
                    {typeof e.maxLevel === 'number' && (
                      <span
                        className="blind-board-final__leaderboard-level"
                        data-testid={`blind-board-final-leaderboard-level-${i + 1}`}
                      >
                        {' '}· L{e.maxLevel}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {onPlayAgain && (
        <button
          type="button"
          className="blind-board-final__again play-btn"
          data-testid="blind-board-final-again"
          onClick={onPlayAgain}
        >
          {t('blindBoard.final.playAgain', 'Play again')}
        </button>
      )}
    </div>
  );
}
