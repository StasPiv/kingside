import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TextStepPayload } from '@kingside/shared';

import { MemoChessboard } from '../../MemoChessboard';
import { renderMarkdown } from '../../../utils/simpleMarkdown';

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
   * Колбэк отметки шага пройденным. Реальная интеграция с
   * `useLessonProgress` — задача L-11 (KS-1766). До неё `LessonPage`
   * передаёт no-op, и кнопка лишь логически «отмечает» шаг.
   */
  onStepDone?: () => void;
  /** Оптический размер диаграммы. По умолчанию 320px. */
  diagramSize?: number;
  /** Скрыть кнопку «Далее» (например, для последнего шага без перехода). */
  hideNext?: boolean;
}

export function TextStep({
  payload,
  onStepDone,
  diagramSize = 320,
  hideNext = false,
}: TextStepProps) {
  const { t } = useTranslation();

  const segments = useMemo(() => parseTextStepSegments(payload), [payload]);

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
          return (
            <figure
              key={idx}
              className="lesson-text-step__diagram"
              data-testid="lesson-text-step-diagram"
              data-fen={seg.fen}
              style={{ width: diagramSize, maxWidth: '100%' }}
            >
              <MemoChessboard
                options={{
                  position: seg.fen,
                  boardOrientation: seg.orientation ?? 'white',
                  allowDragging: false,
                  showNotation: true,
                  animationDurationInMs: 0,
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
            className="lesson-text-step__next"
            data-testid="lesson-text-step-next"
            onClick={() => onStepDone?.()}
          >
            {t('lessons.next', 'Next')}
          </button>
        </div>
      )}
    </div>
  );
}
