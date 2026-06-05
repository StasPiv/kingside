/**
 * KS-3680 / KS-3682 / KS-3691 dev-only песочница: рендерит
 * `AiPositionCommentPanel` во всех состояниях бок о бок и отдельный
 * блок с реальной доской `react-chessboard`, на которую наложен AI
 * overlay (подсветка + стрелки). Используется для приёмочных
 * скриншотов в задачах KS-3680/KS-3682/KS-3691.
 *
 * Доступ: `/__dev/ai-comment-panel` (роут добавлен в `App.tsx`).
 *
 * KS-3691 follow-up: внизу страницы — chessboard-preview с тремя
 * слоями (system → AI overlay → user), чтобы показать живой результат
 * `mergeSquareStyleLayers`/`composeArrowLayers` без необходимости
 * заходить на /analysis.
 */
import { useState } from 'react';
import { Chessboard } from 'react-chessboard';

import { AiPositionCommentPanel } from '../../components/analysis/AiPositionCommentPanel';
import type {
  AiCommentState,
  UseAiPositionCommentResult,
} from '../../hooks/useAiPositionComment';
import {
  SOFT_LIMIT,
  SOFT_WINDOW_MIN,
} from '../../hooks/useAiPositionComment';
import { HIGHLIGHT_COLORS } from '../../hooks/useSquareHighlights';
import {
  composeArrowLayers,
  mergeSquareStyleLayers,
} from '../analysis/aiOverlayMerge';

function noop() {}

function controller(
  state: AiCommentState,
  used = 0,
  overrides: Partial<UseAiPositionCommentResult> = {},
): UseAiPositionCommentResult {
  return {
    state,
    request: noop,
    regenerate: noop,
    softCounter: { used, limit: SOFT_LIMIT, windowMin: SOFT_WINDOW_MIN },
    overlay: null,
    overlayHidden: false,
    toggleOverlay: noop,
    ...overrides,
  };
}

const VARIANTS: Array<{ label: string; ctl: UseAiPositionCommentResult }> = [
  { label: 'idle', ctl: controller({ kind: 'idle' }, 0) },
  { label: 'loading', ctl: controller({ kind: 'loading' }, 1) },
  {
    label: 'success (live)',
    ctl: controller(
      {
        kind: 'success',
        comment:
          'Белые стоят чуть свободнее: пешечная цепь d4–e3 контролирует центр, конь готов прийти на e5. У чёрных слабоват пункт c6, что даёт фигурам белых пространство для манёвра.',
        source: 'live',
        highlights: [],
        arrows: [],
      },
      2,
    ),
  },
  {
    label: 'success (full-review)',
    ctl: controller(
      {
        kind: 'success',
        comment:
          'Из полного разбора партии: «Чёрные сыграли неточно. После c5 у белых сильный пешечный клин в центре, нужно искать активную контригру на ферзевом фланге.»',
        source: 'full-review',
        highlights: [],
        arrows: [],
      },
      3,
    ),
  },
  { label: 'empty', ctl: controller({ kind: 'empty' }, 4) },
  {
    label: 'error',
    ctl: controller({ kind: 'error', message: 'network' }, 5),
  },
  {
    label: 'rate-limited',
    ctl: controller({ kind: 'rate-limited', retryAfterSec: 47 }, 20),
  },
  { label: 'unauthenticated', ctl: controller({ kind: 'unauthenticated' }, 0) },
  { label: 'unsupported', ctl: controller({ kind: 'unsupported' }, 0) },
];

/** Контейнер «как engine-panel» — тёмный фон, padding, рамка. */
function PanelHost({
  children,
  width,
}: {
  children: React.ReactNode;
  width: number | string;
}) {
  return (
    <div
      style={{
        width,
        maxWidth: '100%',
        background: 'var(--c-1a1a2e)',
        border: '1px solid var(--c-2a2a4e)',
        borderRadius: 6,
        padding: 10,
        boxSizing: 'border-box',
      }}
    >
      {children}
    </div>
  );
}

/**
 * KS-3691: блок с реальной доской и наложенным AI overlay поверх
 * системного слоя (last-move) и пользовательских аннотаций. Показывает
 * как сочетаются три слоя, и переключателем «скрыть/показать» можно
 * визуально проверить toggleOverlay.
 */
function OverlayBoardDemo() {
  const [hidden, setHidden] = useState(false);
  // Свешников: 1.e4 c5 2.Nf3 Nc6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 e5
  const fen = 'r1bqkb1r/pp1p1ppp/2n2n2/4p3/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6';
  // Системный слой: last-move e7→e5 (имитируем).
  const systemStyles = {
    e7: { backgroundColor: 'rgba(155, 199, 0, 0.32)' },
    e5: { backgroundColor: 'rgba(155, 199, 0, 0.32)' },
  };
  // AI overlay из ответа модели.
  const aiHighlights = [
    { square: 'd5' as const, color: 'green' as const },
    { square: 'c4' as const, color: 'yellow' as const },
    { square: 'f7' as const, color: 'red' as const },
  ];
  const aiArrows = [
    { from: 'd4' as const, to: 'd5' as const, color: 'green' as const },
    { from: 'f1' as const, to: 'c4' as const, color: 'yellow' as const },
  ];
  // Пользовательский правый клик на e4 (мог бы перекрыть AI на той же
  // клетке — здесь не перекрывает).
  const userStyles = {
    a8: { backgroundColor: 'rgba(0, 121, 191, 0.55)' },
  };
  const aiSquareStyles = hidden
    ? {}
    : Object.fromEntries(
        aiHighlights.map((h) => [
          h.square,
          { backgroundColor: HIGHLIGHT_COLORS[h.color] },
        ]),
      );
  const aiArrowsRender = hidden
    ? []
    : aiArrows.map((a) => ({
        startSquare: a.from,
        endSquare: a.to,
        color: HIGHLIGHT_COLORS[a.color],
      }));
  const mergedStyles = mergeSquareStyleLayers(
    systemStyles,
    aiSquareStyles,
    userStyles,
  );
  const mergedArrows = composeArrowLayers([], aiArrowsRender, []);
  return (
    <section
      data-testid="overlay-board-demo"
      style={{
        marginTop: 28,
        display: 'grid',
        gridTemplateColumns: 'minmax(320px, 480px) 1fr',
        gap: 16,
        alignItems: 'start',
      }}
      className="ai-overlay-demo"
    >
      <div>
        <div style={{ fontSize: 12, marginBottom: 6, color: '#a0a0c0' }}>
          AI overlay поверх системного слоя (last-move) и пользовательских
          аннотаций. Стрелки: зелёная d4→d5 (конь на форпост), жёлтая f1→c4
          (давление на f7). Подсветки: d5 зелёная, c4 жёлтая, f7 красная.
        </div>
        <Chessboard
          options={{
            position: fen,
            squareStyles: mergedStyles,
            arrows: mergedArrows,
            allowDragging: false,
            id: 'ai-overlay-demo-board',
          }}
        />
        <button
          type="button"
          onClick={() => setHidden((v) => !v)}
          style={{ marginTop: 8 }}
        >
          {hidden ? 'Показать overlay' : 'Скрыть overlay'}
        </button>
      </div>
      <pre
        style={{
          fontSize: 11,
          background: '#0b1224',
          color: '#d0d0e0',
          padding: 12,
          borderRadius: 6,
          overflow: 'auto',
        }}
      >
        {JSON.stringify(
          {
            fen,
            ai: { highlights: aiHighlights, arrows: aiArrows },
            hidden,
          },
          null,
          2,
        )}
      </pre>
    </section>
  );
}

export default function AiCommentSandboxPage() {
  return (
    <div
      style={{
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        background: 'var(--c-0f172a, #0f172a)',
        color: 'var(--c-e0e0e0, #e0e0e0)',
        minHeight: '100vh',
      }}
    >
      <h1 style={{ marginTop: 0, fontSize: 20 }}>
        AI Position Comment — все 8 состояний + overlay (KS-3680 / KS-3682 / KS-3691)
      </h1>
      <p style={{ color: 'var(--c-a0a0c0, #a0a0c0)', fontSize: 13 }}>
        Dev-only песочница для приёмочных скриншотов. Слева — desktop-ширина
        панели (~320px, как в engine-panel sidebar), справа — mobile-ширина
        (~360px, как в .analysis-mobile-section--engine). Внизу — доска с
        наложенным AI overlay (KS-3691).
      </p>

      {/* Сетка 5×2 — 9 вариантов (8 state-kind + success/full-review)
          умещаются в одну панораму без скролла. Под mobile viewport
          (≤767px) колонки разворачиваются в 1, и в панелях включается
          mobile-режим вёрстки (full-width кнопка, tap-target ≥44px). */}
      <section
        data-testid="sandbox-grid"
        style={{
          marginTop: 16,
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gap: 10,
        }}
        className="ai-comment-sandbox-grid"
      >
        {VARIANTS.map((v) => (
          <div key={v.label}>
            <div
              style={{
                fontSize: 11,
                color: 'var(--c-a0a0c0, #a0a0c0)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginBottom: 6,
              }}
            >
              {v.label}
            </div>
            <PanelHost width="100%">
              <AiPositionCommentPanel
                controller={v.ctl}
                testIdSuffix="desktop"
                /* KS-3726: для success-кейсов прокидываем «Добавить в
                   комментарий» — sandbox-карточка покажет её рядом с
                   overlay-toggle. Для prefilled («уже в комменте»)
                   варианта прокидываем такой же текст в
                   currentMoveComment — кнопка становится «Добавлено». */
                onAddToComment={v.ctl.state.kind === 'success' ? noop : undefined}
                currentMoveComment={
                  v.ctl.state.kind === 'success' && v.ctl.state.source === 'full-review'
                    ? v.ctl.state.comment
                    : null
                }
              />
            </PanelHost>
          </div>
        ))}
      </section>

      <OverlayBoardDemo />

      <style>{`
        @media (min-width: 768px) {
          /* В sandbox-desktop виде ограничиваем text, чтобы 8 карточек
             поместились в 720px viewport — основные стили текста
             (max-height:160px) проверены на реальной engine-panel. */
          .ai-comment-sandbox-grid {
            grid-auto-rows: 220px !important;
          }
          .ai-comment-sandbox-grid .ai-position-comment__text {
            max-height: 64px;
          }
        }
        @media (max-width: 767px) {
          .ai-comment-sandbox-grid {
            grid-template-columns: 1fr !important;
          }
          .ai-overlay-demo {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}
