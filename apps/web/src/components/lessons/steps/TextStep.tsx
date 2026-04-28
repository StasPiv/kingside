import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DiagramArrow,
  DiagramHighlight,
  LessonStepState,
  TextStepPayload,
} from '@kingside/shared';

import { MemoChessboard } from '../../MemoChessboard';
import { renderMarkdown } from '../../../utils/simpleMarkdown';

/**
 * KS-1995 / KS-1994: дефолтные цвета визуальных подсказок на
 * диаграммах. Подобраны под обычную CSS-палитру шахматных движков:
 * стрелка — оранжевая полупрозрачная, подсветка клетки — жёлтая.
 */
const DEFAULT_ARROW_COLOR = 'rgba(255, 153, 0, 0.85)';
const DEFAULT_HIGHLIGHT_COLOR = 'rgba(255, 213, 0, 0.55)';

/**
 * Read-only текстовый шаг урока: markdown + FEN-диаграммы.
 *
 * # Синтаксис FEN внутри markdown (L-08)
 *
 * Поддерживается **два варианта** встраивания диаграмм. Оба эквивалентны
 * по результату, выбор — на усмотрение автора урока:
 *
 * 1. **Reference-плейсхолдер** `{{diagram:N}}` (N — индекс в `payload.diagrams`,
 *    начиная с 0). Уже задокументирован в `TextStepPayload.diagrams`
 *    (`packages/shared/src/types/lessons.ts`). Пример:
 *
 *    ```markdown
 *    Рассмотрим начальную позицию:
 *
 *    {{diagram:0}}
 *
 *    Белые ходят первыми…
 *    ```
 *
 *    `payload.diagrams[0]` тогда содержит `{ fen, caption?, orientation? }`.
 *
 * 2. **Inline fenced-блок** ```` ```fen [orientation] ```` (orientation —
 *    `white` или `black`, по умолчанию `white`). FEN-строка идёт первой
 *    непустой строкой блока, опциональная подпись — на отдельной строке
 *    после префикса `caption:`. Пример:
 *
 *    ````markdown
 *    Защита Каро-Канн начинается так:
 *
 *    ```fen
 *    rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2
 *    caption: После 1.e4 c6
 *    ```
 *    ````
 *
 *    Inline-форма удобна для одноразовых диаграмм — не нужно описывать их
 *    отдельно в `payload.diagrams`. Reference-форма удобна, если на одну
 *    диаграмму ссылаются несколько раз или её хотят описать декларативно
 *    в payload (полезно для seed-линтера / переводов).
 *
 * Финальный синтаксис согласован с задачей KS-1763 (L-08). Документация
 * в `TextStepPayload` будет дополнена backend-агентом отдельной задачей —
 * `packages/shared` для frontend read-only.
 */

type Segment =
  | { kind: 'markdown'; markdown: string }
  | {
      kind: 'fen';
      fen: string;
      caption?: string;
      orientation?: 'white' | 'black';
      /** KS-1995: стрелки на диаграмме (read-only). */
      arrows?: DiagramArrow[];
      /** KS-1995: подсвеченные клетки. */
      highlightedSquares?: DiagramHighlight[];
    };

const REFERENCE_RE = /\{\{diagram:(\d+)\}\}/g;
const FENCED_FEN_RE = /^```fen(?:\s+(white|black))?\s*$/i;

/**
 * Разбирает markdown на сегменты — обычный текст и FEN-диаграммы.
 * Чистая функция, экспортируется для тестов.
 *
 * # Orphan-диаграммы (KS-1827-bugfix)
 *
 * Если `payload.diagrams[i]` объявлена, но никакой `{{diagram:i}}` на
 * неё не ссылается в `bodyMarkdown` — такая диаграмма рендерится в
 * конец (после всех markdown- и fenced-сегментов). До фикса
 * неотреферированные диаграммы просто молчали, и пользователь user-
 * курсов видел пустое тело шага, хотя визуально «добавил картинку»
 * через редактор. Новое поведение совместимо со старым для всех
 * корректно свёрстанных уроков (где каждая declared-диаграмма имеет
 * ссылку) — для них список orphan'ов пустой.
 */
export function parseTextStepSegments(payload: TextStepPayload): Segment[] {
  const source = (payload.bodyMarkdown ?? '').replace(/\r\n/g, '\n');
  const diagrams = payload.diagrams ?? [];
  const referenced = new Set<number>();

  if (!source) {
    // Пустой markdown — показываем все declared-диаграммы как orphans.
    return diagrams.map((d) => ({
      kind: 'fen' as const,
      fen: d.fen,
      caption: d.caption,
      orientation: d.orientation,
      arrows: d.arrows,
      highlightedSquares: d.highlightedSquares,
    }));
  }

  const lines = source.split('\n');
  const segments: Segment[] = [];

  // Шаг 1: вытаскиваем fenced ```fen``` блоки.
  let buf: string[] = [];
  let i = 0;
  const flushBuf = () => {
    if (buf.length === 0) return;
    const md = buf.join('\n');
    if (md.trim()) {
      // Шаг 2: внутри markdown ищем reference-плейсхолдеры.
      processReferences(md, payload, segments, referenced);
    }
    buf = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const open = line.match(FENCED_FEN_RE);
    if (open) {
      flushBuf();
      const orientation = (open[1]?.toLowerCase() as 'white' | 'black') ?? 'white';
      const inner: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        inner.push(lines[i]);
        i += 1;
      }
      // пропускаем закрывающий ```
      if (i < lines.length) i += 1;

      const nonEmpty = inner.map((l) => l.trim()).filter((l) => l.length > 0);
      if (nonEmpty.length === 0) continue;

      let fen = '';
      let caption: string | undefined;
      for (const l of nonEmpty) {
        if (l.toLowerCase().startsWith('caption:')) {
          caption = l.slice('caption:'.length).trim();
        } else if (!fen) {
          fen = l;
        }
      }
      if (fen) {
        segments.push({ kind: 'fen', fen, caption, orientation });
      }
      continue;
    }
    buf.push(line);
    i += 1;
  }
  flushBuf();

  // Шаг 3: orphan-диаграммы — declared, но не отреферированные. См.
  // doc-комментарий функции. Порядок — как в `payload.diagrams`.
  for (let idx = 0; idx < diagrams.length; idx += 1) {
    if (referenced.has(idx)) continue;
    const d = diagrams[idx];
    segments.push({
      kind: 'fen',
      fen: d.fen,
      caption: d.caption,
      orientation: d.orientation,
      arrows: d.arrows,
      highlightedSquares: d.highlightedSquares,
    });
  }

  return segments;
}

function processReferences(
  md: string,
  payload: TextStepPayload,
  out: Segment[],
  referenced: Set<number>,
): void {
  const diagrams = payload.diagrams ?? [];
  let lastIndex = 0;
  for (const match of md.matchAll(REFERENCE_RE)) {
    const idx = match.index ?? 0;
    const before = md.slice(lastIndex, idx);
    if (before.trim()) {
      out.push({ kind: 'markdown', markdown: before });
    }
    const refIdx = Number(match[1]);
    const diagram = diagrams[refIdx];
    if (diagram) {
      out.push({
        kind: 'fen',
        fen: diagram.fen,
        caption: diagram.caption,
        orientation: diagram.orientation,
        arrows: diagram.arrows,
        highlightedSquares: diagram.highlightedSquares,
      });
      referenced.add(refIdx);
    }
    // Если ссылка «битая», просто пропускаем — не плодим артефакты.
    lastIndex = idx + match[0].length;
  }
  const tail = md.slice(lastIndex);
  if (tail.trim()) {
    out.push({ kind: 'markdown', markdown: tail });
  }
}

interface TextStepProps {
  payload: TextStepPayload;
  /**
   * Колбэк отметки шага пройденным. Вызывается ТОЛЬКО при клике
   * «Далее» (KS-1990). Повторные вызовы безопасны —
   * `useUserLessonProgress.markStep` идемпотентен.
   *
   * История: до KS-1990 был ещё авто-вызов через
   * `TEXT_STEP_AUTO_DONE_MS=1500ms` после mount (KS-1878). Это
   * мешало явному UX-flow: достаточно было открыть урок, чтобы
   * 6/12 шагов сами засчитались. Логика, которую закрывал
   * автомаркер (последний шаг с `hideNext=true` нельзя пометить),
   * теперь решается возвратом кнопки «Далее» на последний шаг —
   * см. `LessonPage`/`UserLessonPage`, они больше не передают
   * `hideNext=true` для последнего шага.
   */
  onStepDone?: () => void;
  /** Оптический размер диаграммы. По умолчанию 320px. */
  diagramSize?: number;
  /** Скрыть кнопку «Далее» (например, для последнего шага без перехода). */
  hideNext?: boolean;
  /**
   * Текущее состояние шага (KS-1891). Если `done`, кнопка
   * «Далее» переключается в визуально пассивный вид «Пройдено ✓»
   * — пользователю наглядно видно что шаг уже зачтён. Клик
   * остаётся (markStep идемпотентен — KS-1879). Для остальных
   * состояний / `undefined` — обычный active-стиль как раньше.
   */
  stepState?: LessonStepState;
}

export function TextStep({
  payload,
  onStepDone,
  diagramSize = 320,
  hideNext = false,
  stepState,
}: TextStepProps) {
  const { t } = useTranslation();
  const isDone = stepState === 'done';

  const segments = useMemo(() => parseTextStepSegments(payload), [payload]);

  // KS-1990: автомаркера больше нет. Прогресс шага засчитывается
  // только по клику пользователя «Далее».

  // bodyI18nKey пока не используется здесь — рендер словарных markdown'ов
  // потребует загрузки строки через i18next, а словари у нас плоские
  // (нет вложенных markdown). Поддержка появится одновременно с seed-pipeline
  // (L-05). Для MVP TextStep работает с `bodyMarkdown`.
  const isEmpty = segments.length === 0;

  return (
    <div className="lesson-text-step" data-testid="lesson-text-step">
      {payload.bodyI18nKey && !payload.bodyMarkdown && (
        <p
          className="lesson-text-step__i18n-stub"
          data-testid="lesson-text-step-i18n-stub"
        >
          {t(payload.bodyI18nKey, '')}
        </p>
      )}

      {!isEmpty &&
        segments.map((seg, idx) => {
          if (seg.kind === 'markdown') {
            return (
              <div
                key={idx}
                className="lesson-text-step__md"
                data-testid="lesson-text-step-md"
                // simpleMarkdown сам экранирует HTML; внешние ссылки получают
                // rel="noopener", внутренние — data-internal.
                dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.markdown) }}
              />
            );
          }
          // KS-1995: маппим бэк-DTO в формат react-chessboard v5.
          // - стрелки: `{ startSquare, endSquare, color }[]`
          // - подсветка клеток: `Record<square, CSSProperties>`
          // Если поля не заданы — передаём `undefined`, чтобы поведение
          // было ровно как до KS-1995 (back-compat).
          const arrowsForBoard = seg.arrows?.length
            ? seg.arrows.map((a) => ({
                startSquare: a.from,
                endSquare: a.to,
                color: a.color ?? DEFAULT_ARROW_COLOR,
              }))
            : undefined;
          const squareStylesForBoard = seg.highlightedSquares?.length
            ? Object.fromEntries(
                seg.highlightedSquares.map((h) => [
                  h.square,
                  { backgroundColor: h.color ?? DEFAULT_HIGHLIGHT_COLOR },
                ]),
              )
            : undefined;
          return (
            <figure
              key={idx}
              className="lesson-text-step__diagram"
              data-testid="lesson-text-step-diagram"
              data-fen={seg.fen}
              data-arrows={seg.arrows?.length ?? 0}
              data-highlights={seg.highlightedSquares?.length ?? 0}
              style={{ width: diagramSize, maxWidth: '100%' }}
            >
              <MemoChessboard
                options={{
                  position: seg.fen,
                  boardOrientation: seg.orientation ?? 'white',
                  allowDragging: false,
                  showNotation: true,
                  animationDurationInMs: 0,
                  arrows: arrowsForBoard,
                  squareStyles: squareStylesForBoard,
                }}
              />
              {seg.caption && (
                <figcaption className="lesson-text-step__caption">
                  {seg.caption}
                </figcaption>
              )}
            </figure>
          );
        })}

      {!hideNext && (
        <div className="lesson-text-step__actions">
          <button
            type="button"
            className={`lesson-text-step__next${isDone ? ' lesson-text-step__next--done' : ''}`}
            data-testid="lesson-text-step-next"
            data-step-state={stepState ?? 'pending'}
            aria-label={
              isDone
                ? t('lessons.stepDone', 'Done ✓')
                : t('lessons.markDone', 'Got it')
            }
            onClick={() => onStepDone?.()}
          >
            {/* KS-2043/KS-2056: единственный способ перейти к
                следующему шагу — нажать «Готово». Кнопка вызывает
                `onStepDone`, который помечает шаг done и переключает
                на следующий. */}
            {isDone
              ? t('lessons.stepDone', 'Done ✓')
              : t('lessons.markDone', 'Got it')}
          </button>
        </div>
      )}
    </div>
  );
}
