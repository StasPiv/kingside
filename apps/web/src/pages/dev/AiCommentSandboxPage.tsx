/**
 * KS-3680 dev-only песочница: рендерит `AiPositionCommentPanel` во всех
 * 8 состояниях бок о бок — для приёмочного скриншота. Используется
 * QA-агентом для скриншот-проверки в задаче KS-3680, в проде не нужна.
 *
 * Доступ: `/__dev/ai-comment-panel` (роут добавлен в `App.tsx`).
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

export default function AiCommentSandboxPage() {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>
        AI Position Comment — все 8 состояний (KS-3680)
      </h1>
      <p>
        Dev-only песочница для приёмочных скриншотов. Стилизация — задача F2.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 16,
        }}
      >
        {VARIANTS.map((v) => (
          <section
            key={v.label}
            style={{
              border: '1px solid #ddd',
              borderRadius: 6,
              padding: 12,
              background: '#fff',
              color: '#111',
            }}
          >
            <h3 style={{ marginTop: 0, fontSize: 13, color: '#444' }}>
              {v.label}
            </h3>
            <AiPositionCommentPanel
              controller={v.ctl}
              testIdSuffix="desktop"
            />
          </section>
        ))}
      </div>
    </div>
  );
}
