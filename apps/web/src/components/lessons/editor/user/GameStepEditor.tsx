import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  AnalysisListItem,
  GameStepMeta,
  GameStepPayload,
} from '@kingside/shared';

import { api } from '../../../../api';

/**
 * KS-3181 / ADR-072 §7 F1 — редактор шага «Партия» для пользовательских
 * курсов. Поддерживает два источника:
 *
 *   1. `sourceType='pgn'` — автор вставляет PGN вручную. Клиент валидирует
 *      через `chess.js#loadPgn` (быстрый фидбек). Backend дублирует
 *      валидацию + лимит 200 КБ (KS-3180).
 *   2. `sourceType='workshop_analysis'` — автор выбирает один из своих
 *      сохранённых анализов из workshop'а (`GET /analyses`). На submit
 *      отправляется ТОЛЬКО `analysisId`; backend сам читает `Analysis`,
 *      проверяет owner и кладёт snapshot `pgn`/`meta` в payload (см.
 *      KS-3180). Клиент не передаёт PGN-текст в этом режиме — backend
 *      перезапишет любое значение `pgn` snapshot'ом.
 *
 * Дизайн-решения:
 *  - Радио-сегмент сверху переключает источник. При переключении
 *    `pgn → workshop_analysis` мы НЕ стираем PGN-текст из локального
 *    state (только из payload), чтобы переключиться обратно и не
 *    потерять введённое. Симметрично — при выборе анализа сохраняем
 *    `analysisId` независимо от вида в PGN-textarea.
 *  - Список анализов грузится одним запросом (limit=100), для F1 этого
 *    хватает: типичный автор курса вряд ли держит >100 разборов. Поиск
 *    клиентский: фильтр по `title`/`white`/`black`/`event`. Lazy-load
 *    /pagination оставлен на следующую итерацию (если потребуется).
 *  - Валидация PGN — `new Chess().loadPgn()` в try/catch. PGN с
 *    отсутствующими тегами `[White]/[Black]` валиден (chess.js не
 *    требует тегов); пустая строка — не валидируется как «ошибка»,
 *    просто disabled submit-сигнал родителю (через payload без pgn).
 *  - `meta` (white/black/result/…) парсится из PGN-заголовка для UI-
 *    превью; на submit `meta` НЕ отправляется — backend сам соберёт
 *    из PGN при сохранении (см. KS-3180). Это снимает дублирование
 *    источника истины: при изменении тегов в PGN backend перепишет
 *    `meta` атомарно.
 */

interface GameStepEditorProps {
  payload: GameStepPayload;
  onChange: (next: GameStepPayload) => void;
}

interface PgnValidation {
  ok: boolean;
  /** Локализованный ключ ошибки. Пусто если PGN валиден или пуст. */
  errorKey: string | null;
}

function validatePgn(pgn: string): PgnValidation {
  const trimmed = pgn.trim();
  if (!trimmed) {
    return { ok: false, errorKey: null }; // пусто — disabled submit, но не ошибка
  }
  try {
    const chess = new Chess();
    chess.loadPgn(trimmed);
    return { ok: true, errorKey: null };
  } catch {
    return { ok: false, errorKey: 'lessons.my.editor.game.pgn.invalid' };
  }
}

function parsePgnMeta(pgn: string): GameStepMeta {
  const meta: GameStepMeta = {};
  const re = /\[(\w+)\s+"([^"]*)"\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) {
    const tag = m[1];
    const value = m[2];
    switch (tag) {
      case 'White':
        meta.white = value;
        break;
      case 'Black':
        meta.black = value;
        break;
      case 'Result':
        meta.result = value;
        break;
      case 'Date':
        meta.date = value;
        break;
      case 'Event':
        meta.event = value;
        break;
      case 'Site':
        meta.site = value;
        break;
      case 'Round':
        meta.round = value;
        break;
      default:
        break;
    }
  }
  return meta;
}

const MAX_PGN_BYTES = 200 * 1024; // ADR-072 §7 B1 / KS-3180

/**
 * KS-3184: placeholder PGN, который мы создаём при добавлении нового
 * шага «Партия» (`emptyStepPayload('game')` → `pgn: '*'`). Это валидный
 * PGN (chess.js принимает; `IsNotEmpty` тоже — 1 символ), но семантически
 * пустой. В редакторе показываем такой PGN как чистое поле — иначе
 * автор увидит загадочную звёздочку в textarea.
 */
const PGN_PLACEHOLDER = '*';
function isPgnPlaceholder(pgn: string): boolean {
  return pgn.trim() === PGN_PLACEHOLDER;
}

export function GameStepEditor({ payload, onChange }: GameStepEditorProps) {
  const { t } = useTranslation();

  // KS-3181: локальный буфер PGN. Хранится отдельно, чтобы переключение
  // sourceType не теряло набранный текст. На каждое реальное изменение
  // прокидываем в родительский payload только когда оно валидно (для
  // backend'а — иначе он отбросит 400; pre-validation в UserCourseEditor
  // дополнительно фильтрует пустой PGN, см. ниже).
  //
  // KS-3184: новый шаг приходит с placeholder pgn=`*` (см. `emptyStepPayload`).
  // В UI это значение скрываем — автор должен видеть пустое поле, а не
  // загадочную звёздочку. При вводе реального PGN autosave заменит
  // placeholder обычным путём.
  const [pgnDraft, setPgnDraft] = useState<string>(() =>
    isPgnPlaceholder(payload.pgn ?? '') ? '' : payload.pgn ?? '',
  );

  // Если из родителя пришёл другой payload (sourceType переключился извне
  // или загружен другой шаг) — синхронизируем буфер.
  useEffect(() => {
    setPgnDraft(
      isPgnPlaceholder(payload.pgn ?? '') ? '' : payload.pgn ?? '',
    );
  }, [payload.pgn]);

  const validation = useMemo(() => validatePgn(pgnDraft), [pgnDraft]);
  const pgnByteLen = useMemo(
    () => new Blob([pgnDraft]).size,
    [pgnDraft],
  );
  const overLimit = pgnByteLen > MAX_PGN_BYTES;

  const onSourceTypeChange = useCallback(
    (next: 'pgn' | 'workshop_analysis') => {
      if (next === payload.sourceType) return;
      if (next === 'pgn') {
        onChange({
          type: 'game',
          sourceType: 'pgn',
          pgn: pgnDraft,
          meta: parsePgnMeta(pgnDraft),
        });
      } else {
        onChange({
          type: 'game',
          sourceType: 'workshop_analysis',
          // analysisId выберется отдельно; до выбора submit будет disabled.
        });
      }
    },
    [onChange, payload.sourceType, pgnDraft],
  );

  const onPgnTextareaChange = useCallback(
    (next: string) => {
      setPgnDraft(next);
      if (payload.sourceType !== 'pgn') return;
      // KS-3181: пушим в payload каждое изменение — родитель сам
      // решает, отправлять ли PATCH (isStepPayloadAutoSavable отсечёт
      // пустой/невалидный PGN). Это даёт мгновенный preview карточки
      // и автосейв после успешной валидации.
      onChange({
        type: 'game',
        sourceType: 'pgn',
        pgn: next,
        meta: parsePgnMeta(next),
      });
    },
    [onChange, payload.sourceType],
  );

  // ── workshop_analysis: список анализов ─────────────────────────────
  const [analyses, setAnalyses] = useState<AnalysisListItem[] | null>(null);
  // KS-3202: фактическое число загруженных при активной пагинации
  // (показывается в подсказке «Loaded N…», чтобы автор видел прогресс
  // и не нажимал refresh при медленном соединении).
  const [loadingCount, setLoadingCount] = useState<number>(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  /**
   * KS-3202: загружаем ВСЕ страницы анализов цикл'ом по 100 штук.
   *
   * Симптом: автор курса (Pivovartsev) искал свою фамилию в анализах,
   * получал «не найдено», хотя в БД анализов с этим именем много. Корень
   * — раньше делался один запрос `/analyses?limit=100&offset=0`, а
   * клиентский поиск фильтровал только эти 100. Если у пользователя
   * >100 анализов, остальные за пределами окна и не попадали в поиск.
   *
   * Сейчас (до server-side search в backend — см. отдельная backend-
   * задача): подгружаем все страницы. Bound — `MAX_PAGES=50` (5000
   * анализов), чтобы случайный bug в pagination'е не повесил клиент в
   * бесконечном цикле. Реальный автор курса вряд ли держит >5000
   * сохранённых анализов; если когда-то будет — переключимся на
   * server-side search через `?search=` (backend task в очереди).
   *
   * Загрузка инкрементальная: после каждой страницы обновляем `analyses`
   * накопительно, чтобы UI начал показывать результаты сразу (типичные
   * первые 100 приходят за <500ms), пока подкачиваются остальные.
   */
  useEffect(() => {
    if (payload.sourceType !== 'workshop_analysis') return;
    if (analyses !== null) return; // уже загружено
    let cancelled = false;
    const PAGE = 100;
    const MAX_PAGES = 50;
    const acc: AnalysisListItem[] = [];

    async function loadAll() {
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          if (cancelled) return;
          const offset = page * PAGE;
          const res = await api.get<AnalysisListItem[]>(
            `/analyses?limit=${PAGE}&offset=${offset}`,
          );
          if (cancelled) return;
          acc.push(...res);
          // Инкрементальный апдейт — UI показывает первую страницу
          // мгновенно, остальные «дотекают» в фоне.
          setAnalyses([...acc]);
          setLoadingCount(acc.length);
          // Если страница меньше PAGE — это последняя.
          if (res.length < PAGE) break;
        }
        setLoadError(null);
      } catch (err: unknown) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : String(err ?? 'unknown'),
        );
        // Если первая страница успела залиться — оставляем её; иначе
        // ставим пустой массив, чтобы UI вышел из loading-state.
        setAnalyses(acc.length > 0 ? acc : []);
      }
    }

    loadAll();
    return () => {
      cancelled = true;
    };
  }, [payload.sourceType, analyses]);

  const filteredAnalyses = useMemo(() => {
    if (!analyses) return null;
    const q = search.trim().toLowerCase();
    if (!q) return analyses;
    return analyses.filter((a) => {
      // KS-3202: расширенные поля для поиска. К старым (title/white/
      // black/event/opening/headline) добавлены `result` (например «1-0»
      // / «1/2-1/2») и `tags` — пользовательские пометки, которые часто
      // содержат имена соперников или название турнира. Имена игроков
      // в БД хранятся как один string (см. AnalysisListItem.white) —
      // фамилия будет найдена через `includes`, независимо от формата
      // «Pivovartsev, S.» / «S. Pivovartsev» / «Pivovartsev».
      const haystack = [
        a.title,
        a.white,
        a.black,
        a.event,
        a.opening,
        a.headline,
        a.result,
        ...(a.tags ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [analyses, search]);

  const onPickAnalysis = useCallback(
    (analysis: AnalysisListItem) => {
      onChange({
        type: 'game',
        sourceType: 'workshop_analysis',
        analysisId: analysis.id,
        // KS-3181: PGN не присылаем — backend сделает snapshot
        // самостоятельно (см. KS-3180). UI до апдейта от backend
        // показывает meta из элемента списка для мгновенной обратной
        // связи. На следующем GET шаг придёт уже с заполненным `pgn`.
        meta: {
          white: analysis.white ?? undefined,
          black: analysis.black ?? undefined,
          result: analysis.result ?? undefined,
          event: analysis.event ?? undefined,
        },
      });
    },
    [onChange],
  );

  // ── Рендер ─────────────────────────────────────────────────────────
  return (
    <div
      className="game-step-editor"
      data-testid="game-step-editor"
      data-source-type={payload.sourceType}
    >
      <div
        className="game-step-editor__source-tabs"
        role="radiogroup"
        aria-label={t(
          'lessons.my.editor.game.sourceTabs.label',
          'Game source',
        )}
      >
        <button
          type="button"
          role="radio"
          aria-checked={payload.sourceType === 'pgn'}
          className={`game-step-editor__tab${payload.sourceType === 'pgn' ? ' game-step-editor__tab--active' : ''}`}
          data-testid="game-step-editor-tab-pgn"
          onClick={() => onSourceTypeChange('pgn')}
        >
          {t('lessons.my.editor.game.sourceTabs.pgn', 'PGN')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={payload.sourceType === 'workshop_analysis'}
          className={`game-step-editor__tab${payload.sourceType === 'workshop_analysis' ? ' game-step-editor__tab--active' : ''}`}
          data-testid="game-step-editor-tab-workshop"
          onClick={() => onSourceTypeChange('workshop_analysis')}
        >
          {t(
            'lessons.my.editor.game.sourceTabs.workshop',
            'From my analyses',
          )}
        </button>
      </div>

      {payload.sourceType === 'pgn' && (
        <div className="game-step-editor__pgn">
          <label
            htmlFor="game-step-editor-pgn-textarea"
            className="game-step-editor__label"
          >
            {t('lessons.my.editor.game.pgn.label', 'PGN')}
          </label>
          <textarea
            id="game-step-editor-pgn-textarea"
            data-testid="game-step-editor-pgn-textarea"
            className="game-step-editor__textarea"
            value={pgnDraft}
            onChange={(e) => onPgnTextareaChange(e.target.value)}
            rows={10}
            placeholder={t(
              'lessons.my.editor.game.pgn.placeholder',
              '[Event "..."]\n[White "..."]\n[Black "..."]\n\n1. e4 e5 2. Nf3 Nc6 ...',
            )}
            aria-invalid={validation.errorKey !== null || overLimit}
            data-invalid={
              validation.errorKey !== null || overLimit ? 'true' : 'false'
            }
          />
          {validation.errorKey && (
            <p
              className="game-step-editor__error"
              data-testid="game-step-editor-pgn-error"
              role="alert"
            >
              {t(
                validation.errorKey,
                'PGN is invalid — chess.js cannot parse it.',
              )}
            </p>
          )}
          {overLimit && (
            <p
              className="game-step-editor__error"
              data-testid="game-step-editor-pgn-over-limit"
              role="alert"
            >
              {t('lessons.my.editor.game.pgn.overLimit', {
                defaultValue:
                  'PGN exceeds 200 KB limit (current: {{kb}} KB).',
                kb: (pgnByteLen / 1024).toFixed(1),
              })}
            </p>
          )}
          {!validation.errorKey && pgnDraft.trim() && !overLimit && (
            <p
              className="game-step-editor__hint"
              data-testid="game-step-editor-pgn-ok"
            >
              {t('lessons.my.editor.game.pgn.ok', 'PGN parsed successfully.')}
            </p>
          )}
        </div>
      )}

      {payload.sourceType === 'workshop_analysis' && (
        <div className="game-step-editor__workshop">
          <label
            htmlFor="game-step-editor-search"
            className="game-step-editor__label"
          >
            {t(
              'lessons.my.editor.game.workshop.search',
              'Search analyses',
            )}
          </label>
          <input
            id="game-step-editor-search"
            data-testid="game-step-editor-workshop-search"
            className="game-step-editor__search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t(
              'lessons.my.editor.game.workshop.searchPlaceholder',
              'White / Black / event / title',
            )}
          />

          {analyses === null && !loadError && (
            <p
              className="game-step-editor__hint"
              data-testid="game-step-editor-workshop-loading"
            >
              {t('common.loading', 'Loading…')}
            </p>
          )}

          {/* KS-3202: подсказка «Загружено N…» во время инкрементальной
              догрузки страниц. Скрывается, когда первая страница ещё не
              пришла (выше работает обычный «Loading…») и когда все
              страницы догружены (loadingCount === analyses.length, см.
              ниже total-counter). */}
          {analyses !== null &&
            loadingCount > 0 &&
            loadingCount === analyses.length &&
            loadingCount % 100 === 0 &&
            !loadError && (
              <p
                className="game-step-editor__hint"
                data-testid="game-step-editor-workshop-loading-more"
              >
                {t('lessons.my.editor.game.workshop.loadingMore', {
                  defaultValue: 'Loaded {{count}}, still fetching…',
                  count: loadingCount,
                })}
              </p>
            )}

          {loadError && (
            <p
              className="game-step-editor__error"
              data-testid="game-step-editor-workshop-error"
              role="alert"
            >
              {t(
                'lessons.my.editor.game.workshop.loadError',
                'Could not load saved analyses.',
              )}
            </p>
          )}

          {analyses && analyses.length === 0 && !loadError && (
            <p
              className="game-step-editor__hint"
              data-testid="game-step-editor-workshop-empty"
            >
              {t(
                'lessons.my.editor.game.workshop.empty',
                'You have no saved analyses yet — open Workshop, save a game, then come back.',
              )}
            </p>
          )}

          {filteredAnalyses && filteredAnalyses.length > 0 && (
            <ul
              className="game-step-editor__analyses-list"
              data-testid="game-step-editor-workshop-list"
            >
              {filteredAnalyses.map((a) => {
                const selected = payload.analysisId === a.id;
                const subtitle = [a.white, a.black]
                  .filter(Boolean)
                  .join(' — ');
                return (
                  <li
                    key={a.id}
                    className={`game-step-editor__analysis-row${selected ? ' game-step-editor__analysis-row--selected' : ''}`}
                    data-testid={`game-step-editor-workshop-item-${a.id}`}
                    data-selected={selected ? 'true' : 'false'}
                  >
                    <button
                      type="button"
                      className="game-step-editor__analysis-btn"
                      onClick={() => onPickAnalysis(a)}
                    >
                      <span className="game-step-editor__analysis-title">
                        {a.title}
                      </span>
                      {subtitle && (
                        <span className="game-step-editor__analysis-subtitle">
                          {subtitle}
                          {a.result ? ` (${a.result})` : ''}
                        </span>
                      )}
                      {a.event && (
                        <span className="game-step-editor__analysis-event">
                          {a.event}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {filteredAnalyses &&
            filteredAnalyses.length === 0 &&
            analyses &&
            analyses.length > 0 && (
              <div
                className="game-step-editor__hint"
                data-testid="game-step-editor-workshop-search-empty"
              >
                {/* KS-3202: при пустом результате — счётчик «из N» и
                    кнопка «Сбросить фильтр». Помогает понять, что список
                    реально не пуст, и легко вернуться к полному виду. */}
                <p style={{ margin: 0 }}>
                  {t(
                    'lessons.my.editor.game.workshop.searchEmptyWithTotal',
                    {
                      defaultValue:
                        'No analyses match the search (out of {{total}} total).',
                      total: analyses.length,
                    },
                  )}
                </p>
                <button
                  type="button"
                  className="game-step-editor__reset-filter"
                  data-testid="game-step-editor-workshop-reset-filter"
                  onClick={() => setSearch('')}
                  style={{ marginTop: 4 }}
                >
                  {t(
                    'lessons.my.editor.game.workshop.resetFilter',
                    'Reset filter',
                  )}
                </button>
              </div>
            )}

          {/* KS-3202: total counter (всегда виден когда есть анализы),
              даёт автору ориентир — особенно полезно при поиске, чтобы
              понимать «отфильтровано 12 из 234». */}
          {analyses && analyses.length > 0 && filteredAnalyses && (
            <p
              className="game-step-editor__total"
              data-testid="game-step-editor-workshop-total"
              style={{ fontSize: 12, opacity: 0.7, margin: '4px 0 0' }}
            >
              {search.trim() !== '' && filteredAnalyses.length > 0
                ? t('lessons.my.editor.game.workshop.totalFiltered', {
                    defaultValue: '{{shown}} of {{total}} matches',
                    shown: filteredAnalyses.length,
                    total: analyses.length,
                  })
                : t('lessons.my.editor.game.workshop.total', {
                    defaultValue: '{{total}} analyses',
                    total: analyses.length,
                  })}
            </p>
          )}

          {!payload.analysisId && (
            <p
              className="game-step-editor__warn"
              data-testid="game-step-editor-workshop-no-selection"
            >
              {t(
                'lessons.my.editor.game.workshop.noSelection',
                'Pick an analysis to attach to this step.',
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
