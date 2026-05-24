/**
 * KS-3298 (M2 F4). Кросс-репертуарная страница `/opening-trainer/reviews`.
 * Список всех due-линий пользователя (mastered + sm2DueAt <= now)
 * из `GET /opening-trainer/reviews/due`. Линии группируются по
 * репертуару (репертуар-заголовок + список линий ниже). По клику на
 * линию — стартуем review-сессию по соответствующему репертуару (бэк
 * сам подбирает конкретную линию из SRS-очереди).
 *
 * Контракт: `GetOpeningReviewsDueResponse.lines` — массив `lines &
 * { repertoireTitle }` (денормализованный, фронту не нужно ходить за
 * repertoires отдельно).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { ApiError } from '../../ApiError';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import type {
  GetOpeningReviewsDueResponse,
  OpeningLineProgressDto,
} from '@kingside/shared';

type DueLine = GetOpeningReviewsDueResponse['lines'][number];

/**
 * KS-3298. Конвертация pathUci в строку SAN-ходов («1.e4 c5 2.Nf3»).
 * Использует chess.js — играем UCI'и от стартовой позиции, собираем SAN.
 * Если PGN-кастомная стартовая FEN — не угадаем (но M1 поддерживает
 * только стандартную); это допущение совпадает с backend repertoire-
 * builder'ом.
 */
function pathUciToSan(pathUci: string[]): string {
  if (pathUci.length === 0) return '';
  const c = new Chess();
  const sans: string[] = [];
  for (const uci of pathUci) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const move = c.move({ from, to, promotion });
    if (!move) {
      // Невалидный путь — выходим с тем что собрали.
      sans.push('?');
      break;
    }
    sans.push(move.san);
  }
  // Форматируем как «1.e4 c5 2.Nf3 d6».
  const out: string[] = [];
  for (let i = 0; i < sans.length; i++) {
    if (i % 2 === 0) {
      out.push(`${Math.floor(i / 2) + 1}.${sans[i]}`);
    } else {
      out[out.length - 1] += ` ${sans[i]}`;
    }
  }
  return out.join(' ');
}

interface GroupedReviews {
  repertoireId: string;
  repertoireTitle: string;
  lines: DueLine[];
}

function groupByRepertoire(lines: DueLine[]): GroupedReviews[] {
  const map = new Map<string, GroupedReviews>();
  for (const l of lines) {
    let group = map.get(l.repertoireId);
    if (!group) {
      group = {
        repertoireId: l.repertoireId,
        repertoireTitle: l.repertoireTitle,
        lines: [],
      };
      map.set(l.repertoireId, group);
    }
    group.lines.push(l);
  }
  // Сортируем линии внутри группы по dueAt (раньше → раньше).
  for (const g of map.values()) {
    g.lines.sort((a, b) => {
      const da = a.sm2DueAt ? new Date(a.sm2DueAt).getTime() : 0;
      const db = b.sm2DueAt ? new Date(b.sm2DueAt).getTime() : 0;
      return da - db;
    });
  }
  return Array.from(map.values());
}

export function OpeningTrainerReviewsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [lines, setLines] = useState<DueLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startingFor, setStartingFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    openingTrainerApi
      .getReviewsDue()
      .then((r) => {
        if (!cancelled) setLines(r.lines);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof ApiError
            ? err.message
            : t(
                'openingTrainer.reviews.errors.loadFailed',
                'Failed to load due reviews',
              );
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const grouped = useMemo(() => groupByRepertoire(lines), [lines]);

  const handleStart = useCallback(
    async (line: OpeningLineProgressDto) => {
      if (startingFor) return;
      setStartingFor(line.id);
      try {
        const res = await openingTrainerApi.startSession(line.repertoireId, {
          side: 'white',
          mode: 'review',
          repeatMode: 'complete',
        });
        navigate(
          `/opening-trainer/${line.repertoireId}/session/${res.session.id}`,
          {
            state: {
              initialBotMove: res.initialBotMove,
              session: res.session,
            },
          },
        );
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.message
            : t('openingTrainer.errors.startFailed', 'Failed to start session');
        setError(msg);
        setStartingFor(null);
      }
    },
    [startingFor, navigate, t],
  );

  if (loading) {
    return <div className="loading">{t('common.loading')}</div>;
  }

  return (
    <div className="opening-trainer-reviews" data-testid="opening-trainer-reviews">
      <Link to="/opening-trainer" className="back-link">
        ← {t('openingTrainer.detail.backToList', 'All repertoires')}
      </Link>

      <header>
        <h1>{t('openingTrainer.reviews.title', 'Reviews due')}</h1>
        <p className="opening-trainer-reviews__subtitle">
          {t(
            'openingTrainer.reviews.subtitle',
            'Mastered lines ready for repetition (SRS).',
          )}
        </p>
      </header>

      {error && (
        <div className="error" data-testid="opening-trainer-reviews-error">
          {error}
        </div>
      )}

      {!error && grouped.length === 0 && (
        <div
          className="empty-state"
          data-testid="opening-trainer-reviews-empty"
        >
          <p>
            {t(
              'openingTrainer.reviews.empty',
              'Nothing to review right now. Come back later.',
            )}
          </p>
        </div>
      )}

      {grouped.length > 0 && (
        <ul
          className="opening-trainer-reviews__groups"
          data-testid="opening-trainer-reviews-groups"
        >
          {grouped.map((group) => (
            <li
              key={group.repertoireId}
              className="opening-trainer-reviews__group"
              data-testid={`opening-trainer-reviews-group-${group.repertoireId}`}
            >
              <header className="opening-trainer-reviews__group-header">
                <Link to={`/opening-trainer/${group.repertoireId}`}>
                  <h2>{group.repertoireTitle}</h2>
                </Link>
                <span className="opening-trainer-reviews__group-count">
                  {t('openingTrainer.reviews.lineCount', '{{count}} lines', {
                    count: group.lines.length,
                  })}
                </span>
              </header>
              <ul className="opening-trainer-reviews__lines">
                {group.lines.map((line) => (
                  <li
                    key={line.id}
                    className="opening-trainer-reviews__line"
                    data-testid={`opening-trainer-reviews-line-${line.id}`}
                  >
                    <button
                      type="button"
                      className="opening-trainer-reviews__line-button"
                      onClick={() => handleStart(line)}
                      disabled={startingFor !== null}
                    >
                      <span className="opening-trainer-reviews__line-san">
                        {pathUciToSan(line.pathUci) || line.pathUci.join(' ')}
                      </span>
                      {line.sm2DueAt && (
                        <span className="opening-trainer-reviews__line-due">
                          {new Date(line.sm2DueAt).toLocaleDateString()}
                        </span>
                      )}
                      {startingFor === line.id && (
                        <span className="opening-trainer-reviews__line-starting">
                          {t('openingTrainer.detail.starting', 'Starting…')}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
