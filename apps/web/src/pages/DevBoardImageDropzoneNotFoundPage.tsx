import { useState } from 'react';
import { SetPositionModal } from '../components/SetPositionModal';

/**
 * KS-3094 dev-песочница для crop-flow.
 *
 * Открывает `SetPositionModal` на вкладке «From image», моком
 * `window.fetch` возвращает 400 `board_not_detected` на ПЕРВЫЙ запрос
 * к `/board-recognition` и 422 `recognition_unreliable` с тем самым
 * fenAttempt из KS-3093 — на ВТОРОЙ (после crop'а). Так qa может в
 * один заход проверить:
 *   1. дроп файла → 400 → crop-оверлей с квадратной рамкой 1:1;
 *   2. drag / pinch / двигать рамку (mobile-портрет одним пальцем);
 *   3. «Обрезать и распознать заново» → новый POST → 422 → SetPositionModal
 *      автоматически переключается на Board Editor с предзаполненной
 *      позицией из fenAttempt (a1 = P, должно быть R);
 *   4. в editor'е перенести wR на a1 кликом → Apply.
 *
 * Tree-shake'ается из prod-сборки (KS-1821, `import.meta.env.DEV`).
 */

const UNRELIABLE_BODY = JSON.stringify({
  error: 'recognition_unreliable',
  message: 'sanity check failed',
  fenAttempt:
    'r2q1rk1/ppp1b1pp/1nn1pP2/5b2/2PP4/2N1BN2/PP2B1PP/P2Q1RK1 w - - 0 1',
  issues: ['some pawns are on the edge rows'],
  lowConfidenceCells: [
    { file: 0, rank: 7, piece: 'P', confidence: 0.51 },
  ],
  orientation: 'white',
  modelVersion: '0.9.3',
});

const NOT_DETECTED_BODY = JSON.stringify({
  error: 'board_not_detected',
  message: 'no board square found',
});

let installed = false;
let attempts = 0;
function installFetchMock() {
  if (installed) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes('/board-recognition')) {
      attempts += 1;
      await new Promise((r) => setTimeout(r, 80));
      if (attempts === 1) {
        return new Response(NOT_DETECTED_BODY, {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(UNRELIABLE_BODY, {
        status: 422,
        headers: { 'content-type': 'application/json' },
      });
    }
    return original(input, init);
  };
}

export function DevBoardImageDropzoneNotFoundPage() {
  installFetchMock();
  const [open, setOpen] = useState(true);
  const [appliedFen, setAppliedFen] = useState<string | null>(null);

  return (
    <div style={{ maxWidth: 880, margin: '24px auto', padding: 16 }}>
      <h1>KS-3094 — board_not_detected → Crop → recognize</h1>
      <p style={{ color: '#888', marginBottom: 16 }}>
        Сценарий: первая загрузка картинки даёт 400 — открывается
        crop-оверлей. После «Обрезать и распознать заново» мок шлёт 422
        c fenAttempt → SetPositionModal автоматически переключается на
        Board Editor с предзаполненной позицией (KS-3093 flow).
      </p>
      {!open && (
        <button type="button" onClick={() => setOpen(true)}>
          Open SetPositionModal again
        </button>
      )}
      {appliedFen && (
        <div
          style={{
            marginTop: 24,
            padding: 12,
            background: 'rgba(60,200,120,0.12)',
            borderRadius: 6,
          }}
          data-testid="dev-board-image-dropzone-notfound-applied"
        >
          <strong>Applied:</strong>
          <pre
            style={{
              margin: '6px 0 0',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {appliedFen}
          </pre>
        </div>
      )}
      {open && (
        <SetPositionModal
          initialTab="image"
          onApply={(fen) => {
            setAppliedFen(fen);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
