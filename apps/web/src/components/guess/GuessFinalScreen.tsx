import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  GuessSide,
  GuessMoveDto,
  FinishGuessSessionResponse,
} from '@kingside/shared';

/**
 * KS-3411 (ADR-086 §9, F2) — финал-экран guess-the-move.
 *
 * «Ты X% ★ vs Игрок Y% ★» + список ходов (сильнее/совпал/слабее с бейджем
 * класса). Все метрики — серверные (server-trust): из `FinishGuessSessionResponse`
 * (две точности, звёзды, outcome) и накопленных `GuessMoveDto` (verdict/класс).
 */

export interface GuessFinalScreenProps {
  side: GuessSide;
  moves: GuessMoveDto[];
  finalResult: FinishGuessSessionResponse | null;
  /** Текущий счёт (на случай, если finish не вернулся). */
  score: number;
}

function stars(n: number | null): string {
  if (n == null) return '';
  const full = Math.max(0, Math.min(5, Math.round(n)));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v)}%`;
}

/**
 * KS-3434: конвертация UCI ('c7c5', 'b8c6', 'e7e8q') в SAN ('c5', 'Nc6',
 * 'e8=Q'). chess.js принимает {from,to,promotion?} и возвращает SAN с
 * корректной дизамбигуацией, шахом «+» и матом «#». fenBefore хранится
 * в каждом GuessMoveDto — раздельно для каждого хода (отсюда независимо
 * восстанавливаемая позиция, не нужно переигрывать всю партию).
 *
 * Fallback на сырой UCI при невалидном ходе/FEN — лучше показать что-то,
 * чем уронить экран на финал-экране после длинной партии.
 */
function uciToSan(fen: string, uci: string): string {
  try {
    const g = new Chess(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const mv = g.move({ from, to, promotion });
    return mv?.san ?? uci;
  } catch {
    return uci;
  }
}

export function GuessFinalScreen({
  moves,
  finalResult,
  score,
}: GuessFinalScreenProps) {
  const { t } = useTranslation();
  const session = finalResult?.session ?? null;
  const outcome = finalResult?.outcome ?? null;

  const verdictLabel = (v: GuessMoveDto['verdict']): string => {
    switch (v) {
      case 'strongest':
        return t('guess.verdict.strongest', 'You found the strongest move!');
      case 'betterThanPlayer':
        return t('guess.verdict.betterThanPlayer', 'Stronger than the game move!');
      case 'asPlayer':
        return t('guess.verdict.asPlayer', 'Same as the game move.');
      case 'weaker':
        return t('guess.verdict.weaker', 'Weaker than the game move.');
    }
  };

  const outcomeText =
    outcome === 'userBetter'
      ? t('guess.final.userBetter', 'You played more accurately than the game!')
      : outcome === 'playerBetter'
        ? t('guess.final.playerBetter', 'The game was played more accurately.')
        : outcome === 'tie'
          ? t('guess.final.tie', 'A dead heat — same accuracy.')
          : null;

  return (
    <div className="guess-final" data-testid="guess-final">
      <h2 data-testid="guess-final-title">
        {t('guess.final.title', 'Game finished')}
      </h2>

      <div className="guess-final__scores" data-testid="guess-final-scores">
        <div className="guess-final__score guess-final__score--user" data-testid="guess-final-user">
          <span className="guess-final__who">{t('guess.final.you', 'You')}</span>
          <span className="guess-final__pct" data-testid="guess-final-user-accuracy">
            {pct(session?.userAccuracy ?? null)}
          </span>
          <span className="guess-final__stars" data-testid="guess-final-user-stars">
            {stars(session?.userStars ?? null)}
          </span>
        </div>
        <span className="guess-final__vs">{t('guess.final.vs', 'vs')}</span>
        <div className="guess-final__score guess-final__score--player" data-testid="guess-final-player">
          <span className="guess-final__who">{t('guess.final.player', 'Game')}</span>
          <span className="guess-final__pct" data-testid="guess-final-player-accuracy">
            {pct(session?.playerAccuracy ?? null)}
          </span>
        </div>
      </div>

      {outcomeText && (
        <p className="guess-final__outcome" data-testid="guess-final-outcome">
          {outcomeText}
        </p>
      )}

      <div className="guess-final__gamification" data-testid="guess-final-gamification">
        <span data-testid="guess-final-score">
          {t('guess.hud.score', 'Score')}: {session?.score ?? score}
        </span>
        <span data-testid="guess-final-best-streak">
          {t('guess.final.bestStreak', 'Best streak')}: {session?.bestStreak ?? 0}
        </span>
        <span data-testid="guess-final-better-count">
          {t('guess.hud.betterThanPlayer', 'Stronger than game')}:{' '}
          {session?.betterThanPlayerCount ?? 0}
        </span>
      </div>

      <ol className="guess-final__moves" data-testid="guess-final-moves">
        {moves.map((m) => (
          <li
            key={m.ply}
            className={`guess-final__move guess-final__move--${m.verdict}`}
            data-testid={`guess-final-move-${m.ply}`}
            data-verdict={m.verdict}
            data-user-class={m.userClass}
          >
            <span className="guess-final__move-ply">
              {Math.ceil(m.ply / 2)}.
            </span>
            {/* KS-3434: SAN вместо UCI. fenBefore берём из самого DTO —
                это позиция перед ходом, в ней chess.js корректно отдаёт
                дизамбигуацию, шах/мат. */}
            <span className="guess-final__move-user">
              {uciToSan(m.fenBefore, m.userUci)}
            </span>
            <span
              className={`guess-final__move-badge guess-final__move-badge--${m.userClass}`}
            >
              {t(`guess.class.${m.userClass}`, m.userClass)}
            </span>
            <span className="guess-final__move-verdict">{verdictLabel(m.verdict)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
