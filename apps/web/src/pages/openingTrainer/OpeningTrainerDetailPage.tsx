/**
 * KS-3273 (ADR-077 §2.8 #3) + KS-3295 (M2 F1) + KS-3297 (M2 F3).
 *
 * Карточка репертуара:
 *   - Заголовок/описание/счётчики (nodes/edges/depth).
 *   - Sticky-карточка «Продолжить тренировку» (F3) если есть active-session.
 *   - 4 кнопки режимов с counter'ами (F1): «Новые», «По расписанию»,
 *     «Ошибки», «Свободно». Counter — кол-во линий с соответствующим
 *     статусом из GET /progress. Disabled если counter == 0.
 *   - Кнопка «Удалить».
 *
 * Старт тренировки: POST /repertoires/:id/sessions → navigate(`/session/:sid`).
 * При side='black' бэк сразу возвращает initialBotMove → пробрасываем
 * через location.state.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../ApiError';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import { RepertoireTreeView } from './RepertoireTreeView';
import type {
  OpeningLineProgressDto,
  OpeningRepertoireDetailDto,
  OpeningTrainerMode,
  OpeningTrainerSessionDto,
  StartOpeningTrainerSessionResponse,
  TrainerColor,
} from '@kingside/shared';

interface ModeInfo {
  mode: OpeningTrainerMode;
  count: number;
  titleKey: string;
  titleDefault: string;
  descKey: string;
  descDefault: string;
  icon: string;
}

/**
 * KS-3295. Вычисляем counter'ы режимов из progress.lines:
 *  - learn:    not-played + learning (новые / в процессе изучения)
 *  - review:   due (mastered с истёкшим SRS-интервалом)
 *  - mistakes: wrong (преобладают ошибки)
 *  - free:     все не-orphan линии (свободная прогонка по дереву)
 *
 * Не считаем orphan'ы (старые линии из удалённого PGN).
 */
function countLines(
  lines: OpeningLineProgressDto[],
  totalLeafLines: number,
): Record<OpeningTrainerMode, number> {
  let learn = 0;
  let review = 0;
  let mistakes = 0;
  let touched = 0;
  for (const l of lines) {
    if (l.orphaned) continue;
    touched += 1;
    switch (l.status) {
      case 'not-played':
      case 'learning':
        learn += 1;
        break;
      case 'due':
        review += 1;
        break;
      case 'wrong':
        mistakes += 1;
        break;
      default:
        break;
    }
  }
  // Линии, ещё не получившие записи в progress, — это «новые». Сервер
  // отдаёт записи только для тех линий, по которым были попытки;
  // «новые» приходят как not-played или вовсе отсутствуют в массиве.
  // totalLeafLines (если знаем общее число листьев в дереве) даёт
  // правильную нижнюю границу для learn-счётчика.
  const untouched = Math.max(0, totalLeafLines - touched);
  return {
    learn: learn + untouched,
    review,
    mistakes,
    free: totalLeafLines, // free — по всему дереву
  };
}

export function OpeningTrainerDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [repertoire, setRepertoire] = useState<OpeningRepertoireDetailDto | null>(null);
  const [progress, setProgress] = useState<OpeningLineProgressDto[] | null>(null);
  const [activeSession, setActiveSession] = useState<OpeningTrainerSessionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Side stays as a single selector — режим теперь задаёт кнопка.
  const [side, setSide] = useState<TrainerColor>('white');
  const [starting, setStarting] = useState<OpeningTrainerMode | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    // KS-3295/3297: параллельно тянем repertoire + progress + active-session.
    // Progress и active-session не критичны (M2-фича) — при ошибке
    // отрисовываем без счётчиков/sticky-карточки.
    Promise.allSettled([
      openingTrainerApi.getRepertoire(id),
      openingTrainerApi.getRepertoireProgress(id),
      openingTrainerApi.getRepertoireActiveSession(id),
    ])
      .then(([rRes, pRes, sRes]) => {
        if (cancelled) return;
        if (rRes.status === 'fulfilled') {
          setRepertoire(rRes.value);
        } else {
          const err = rRes.reason;
          const msg =
            err instanceof ApiError
              ? err.message
              : t('openingTrainer.errors.loadFailed', 'Failed to load repertoire');
          setError(msg);
        }
        if (pRes.status === 'fulfilled') {
          setProgress(pRes.value.lines);
        }
        if (sRes.status === 'fulfilled') {
          setActiveSession(sRes.value.session);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  const totalLeafLines = useMemo(() => {
    // Грубая оценка: листовые ноды (без edges) — концы вариантов.
    // Не идеально для tree-view с транспозициями, но подходит для
    // counter'а «всего линий». Backend в L1 может дать точный
    // totalLines в progress-response, тогда заменим.
    if (!repertoire) return 0;
    let leaves = 0;
    for (const node of Object.values(repertoire.tree.nodes)) {
      if (node.edges.length === 0) leaves += 1;
    }
    return leaves;
  }, [repertoire]);

  const counters = useMemo(
    () => countLines(progress ?? [], totalLeafLines),
    [progress, totalLeafLines],
  );

  const handleStart = useCallback(
    async (mode: OpeningTrainerMode) => {
      if (!id || starting) return;
      setStarting(mode);
      setStartError(null);
      try {
        const res: StartOpeningTrainerSessionResponse = await openingTrainerApi.startSession(
          id,
          { side, mode, repeatMode: 'complete' },
        );
        navigate(`/opening-trainer/${id}/session/${res.session.id}`, {
          state: { initialBotMove: res.initialBotMove, session: res.session },
        });
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.message
            : t('openingTrainer.errors.startFailed', 'Failed to start session');
        setStartError(msg);
        setStarting(null);
      }
    },
    [id, starting, side, navigate, t],
  );

  const handleContinue = useCallback(() => {
    if (!activeSession || !id) return;
    navigate(`/opening-trainer/${id}/session/${activeSession.id}`);
  }, [activeSession, id, navigate]);

  const handleDelete = useCallback(async () => {
    if (!id) return;
    if (!window.confirm(t('openingTrainer.detail.confirmDelete', 'Delete this repertoire?'))) {
      return;
    }
    try {
      await openingTrainerApi.deleteRepertoire(id);
      navigate('/opening-trainer', { replace: true });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : t('openingTrainer.errors.deleteFailed', 'Failed to delete repertoire');
      setStartError(msg);
    }
  }, [id, navigate, t]);

  if (loading) {
    return <div className="loading">{t('common.loading')}</div>;
  }

  if (error || !repertoire) {
    return (
      <div className="opening-trainer-detail" data-testid="opening-trainer-detail-error">
        <p className="error">{error ?? t('openingTrainer.errors.notFound', 'Not found')}</p>
        <Link to="/opening-trainer">{t('common.back', 'Back')}</Link>
      </div>
    );
  }

  const modes: ModeInfo[] = [
    {
      mode: 'learn',
      count: counters.learn,
      titleKey: 'openingTrainer.detail.modes.learn.title',
      titleDefault: 'New lines',
      descKey: 'openingTrainer.detail.modes.learn.desc',
      descDefault: 'Lines you haven’t finished yet.',
      icon: '✨',
    },
    {
      mode: 'review',
      count: counters.review,
      titleKey: 'openingTrainer.detail.modes.review.title',
      titleDefault: 'Scheduled',
      descKey: 'openingTrainer.detail.modes.review.desc',
      descDefault: 'Mastered lines due for review (SRS).',
      icon: '🔁',
    },
    {
      mode: 'mistakes',
      count: counters.mistakes,
      titleKey: 'openingTrainer.detail.modes.mistakes.title',
      titleDefault: 'Mistakes',
      descKey: 'openingTrainer.detail.modes.mistakes.desc',
      descDefault: 'Lines where wrongs prevail over corrects.',
      icon: '⚠️',
    },
    {
      mode: 'free',
      count: counters.free,
      titleKey: 'openingTrainer.detail.modes.free.title',
      titleDefault: 'Free practice',
      descKey: 'openingTrainer.detail.modes.free.desc',
      descDefault: 'Walk through any line without scoring.',
      icon: '🎲',
    },
  ];

  return (
    <div className="opening-trainer-detail" data-testid="opening-trainer-detail">
      <Link to="/opening-trainer" className="back-link">
        ← {t('openingTrainer.detail.backToList', 'All repertoires')}
      </Link>

      <header className="opening-trainer-detail__header">
        <h1>{repertoire.title}</h1>
        {repertoire.description && (
          <p className="opening-trainer-detail__description">{repertoire.description}</p>
        )}
      </header>

      <section className="opening-trainer-detail__stats">
        <div className="stat">
          <span className="stat__value">{repertoire.tree.meta.nodeCount}</span>
          <span className="stat__label">
            {t('openingTrainer.detail.stats.positions', 'Positions')}
          </span>
        </div>
        <div className="stat">
          <span className="stat__value">{repertoire.tree.meta.edgeCount}</span>
          <span className="stat__label">
            {t('openingTrainer.detail.stats.moves', 'Moves')}
          </span>
        </div>
        <div className="stat">
          <span className="stat__value">{repertoire.tree.meta.maxDepth}</span>
          <span className="stat__label">
            {t('openingTrainer.detail.stats.depth', 'Max depth')}
          </span>
        </div>
      </section>

      {/* KS-3297 (F3): sticky-карточка «Продолжить тренировку». Появляется
          если backend вернул active-session (lastActivityAt > now-7d,
          finishedAt IS NULL). Клик ведёт прямо в /session/:sid. */}
      {activeSession && (
        <section
          className="opening-trainer-detail__continue"
          data-testid="opening-trainer-continue"
        >
          <div className="opening-trainer-detail__continue-text">
            <strong>
              {t('openingTrainer.detail.continue.title', 'Continue training')}
            </strong>
            <span className="opening-trainer-detail__continue-meta">
              {t('openingTrainer.detail.continue.meta', 'Score {{score}} · {{moves}} moves', {
                score: activeSession.score,
                moves: activeSession.movesPlayed,
              })}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleContinue}
            data-testid="opening-trainer-continue-btn"
          >
            {t('openingTrainer.detail.continue.cta', 'Continue')}
          </button>
        </section>
      )}

      <section className="opening-trainer-detail__start">
        <h2>{t('openingTrainer.detail.start.title', 'Start training')}</h2>

        <div className="form-field">
          <span className="form-field__label">
            {t('openingTrainer.detail.start.side', 'Play as')}
          </span>
          <div className="radio-group">
            <label>
              <input
                type="radio"
                name="side"
                value="white"
                checked={side === 'white'}
                onChange={() => setSide('white')}
                data-testid="opening-trainer-side-white"
              />
              {t('openingTrainer.detail.start.white', 'White')}
            </label>
            <label>
              <input
                type="radio"
                name="side"
                value="black"
                checked={side === 'black'}
                onChange={() => setSide('black')}
                data-testid="opening-trainer-side-black"
              />
              {t('openingTrainer.detail.start.black', 'Black')}
            </label>
          </div>
        </div>

        {/* KS-3295 (F1): 4 кнопки режимов с counter'ами. Заменяет старый
            select на учёный grid. */}
        <div
          className="opening-trainer-detail__modes"
          data-testid="opening-trainer-modes"
        >
          {modes.map((m) => {
            const disabled = m.count === 0 || starting !== null;
            const isStarting = starting === m.mode;
            return (
              <button
                key={m.mode}
                type="button"
                className="opening-trainer-mode-button"
                disabled={disabled}
                onClick={() => handleStart(m.mode)}
                data-testid={`opening-trainer-mode-${m.mode}`}
                data-count={m.count}
              >
                {/* KS-3303: явный inline `display: block` на каждой
                    строке. Раньше все элементы были `<span>` (inline)
                    и без CSS-классов от layout-агента title и
                    description слипались в одну строку. */}
                <span
                  className="opening-trainer-mode-button__icon"
                  aria-hidden="true"
                  style={{ display: 'block' }}
                >
                  {m.icon}
                </span>
                <span
                  className="opening-trainer-mode-button__body"
                  style={{ display: 'block' }}
                >
                  <span
                    className="opening-trainer-mode-button__title"
                    style={{ display: 'block', fontWeight: 600 }}
                  >
                    {t(m.titleKey, m.titleDefault)}
                  </span>
                  <span
                    className="opening-trainer-mode-button__desc"
                    style={{ display: 'block', opacity: 0.75, marginTop: 2 }}
                  >
                    {t(m.descKey, m.descDefault)}
                  </span>
                  <span
                    className="opening-trainer-mode-button__count"
                    style={{ display: 'block', marginTop: 4, fontSize: 12 }}
                  >
                    {isStarting
                      ? t('openingTrainer.detail.starting', 'Starting…')
                      : // KS-3303: count с plural-rules (i18next выберет
                        // _one / _few / _many / _other по locale).
                        t('openingTrainer.detail.modes.count', {
                          count: m.count,
                          defaultValue: '{{count}} lines',
                          defaultValue_one: '{{count}} line',
                        })}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {startError && <div className="error">{startError}</div>}
      </section>

      {/* KS-3296 (F2): дерево репертуара с покраской по статусу линий. */}
      <section className="opening-trainer-detail__tree">
        <h2>{t('openingTrainer.tree.title', 'Repertoire')}</h2>
        <RepertoireTreeView tree={repertoire.tree} lines={progress ?? []} />
      </section>

      <section className="opening-trainer-detail__danger">
        <button
          type="button"
          className="btn btn-danger"
          onClick={handleDelete}
          data-testid="opening-trainer-delete"
        >
          {t('openingTrainer.detail.delete', 'Delete repertoire')}
        </button>
      </section>
    </div>
  );
}
