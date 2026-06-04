/**
 * KS-3680/KS-3682 dev-only песочница: рендерит `AiPositionCommentPanel` во
 * всех 8 состояниях бок о бок — для приёмочного скриншота. Используется
 * QA-агентом и layout-агентом для скриншот-проверки.
 *
 * Доступ: `/__dev/ai-comment-panel` (роут добавлен в `App.tsx`).
 *
 * KS-3682 layout-фолловап: фон страницы и карточек переведён под
 * тёмную тему engine-panel — иначе невозможно оценить контраст бордера/
 * фона панели в естественной среде. Добавлен mobile-узкий столбец, где
 * рендерится `testIdSuffix="mobile"` — чтобы один dev-роут давал и
 * desktop-, и mobile-скриншоты.
 */
import { AiPositionCommentPanel } from '../../components/analysis/AiPositionCommentPanel';
import type {
  AiCommentState,
  UseAiPositionCommentResult,
} from '../../hooks/useAiPositionComment';
import {
  SOFT_LIMIT,
  SOFT_WINDOW_MIN,
} from '../../hooks/useAiPositionComment';

function noop() {}

function controller(
  state: AiCommentState,
  used = 0,
): UseAiPositionCommentResult {
  return {
    state,
    request: noop,
    regenerate: noop,
    softCounter: { used, limit: SOFT_LIMIT, windowMin: SOFT_WINDOW_MIN },
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
        AI Position Comment — все 8 состояний (KS-3680 / KS-3682)
      </h1>
      <p style={{ color: 'var(--c-a0a0c0, #a0a0c0)', fontSize: 13 }}>
        Dev-only песочница для приёмочных скриншотов. Слева — desktop-ширина
        панели (~320px, как в engine-panel sidebar), справа — mobile-ширина
        (~360px, как в .analysis-mobile-section--engine).
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
              />
            </PanelHost>
          </div>
        ))}
      </section>
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
        }
      `}</style>
    </div>
  );
}
