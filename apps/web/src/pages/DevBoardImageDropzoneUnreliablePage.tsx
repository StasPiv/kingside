import { useState } from 'react';
import { SetPositionModal } from '../components/SetPositionModal';

/**
 * KS-3093 dev-песочница для нового flow «после распознавания → board
 * editor».
 *
 * Использует полный `SetPositionModal` (FEN / Board Editor / From image)
 * с глобально мокнутым recognizer'ом: любой загруженный файл вызывает
 * 422 `recognition_unreliable` с тем самым fenAttempt из жалобы юзера
 * (a1 = пешка вместо ладьи). После «успешного» распознавания модал
 * автоматически переключается на вкладку Board Editor с заполненной
 * позицией, можно править фигуры кликом / настраивать рокировку и
 * side-to-move.
 *
 * Для активации мока recognizer'а используем
 * `VITE_BOARD_RECOG_FORCE_MOCK=1`-ветку нельзя (там 200 со стартпозом),
 * поэтому жёстко подменяем `fetch` на уровне страницы: возвращаем 422
 * с заранее подготовленным телом. После размонтирования страницы
 * восстанавливаем оригинал.
 */

const UNRELIABLE_BODY = JSON.stringify({
  error: 'recognition_unreliable',
  message: 'sanity check failed',
  // Точно из жалобы пользователя: модель распознала всё кроме a1.
  fenAttempt:
    'r2q1rk1/ppp1b1pp/1nn1pP2/5b2/2PP4/2N1BN2/PP2B1PP/P2Q1RK1 w - - 0 1',
  issues: ['some pawns are on the edge rows'],
  lowConfidenceCells: [
    { file: 0, rank: 7, piece: 'P', confidence: 0.51 },
    { file: 5, rank: 2, piece: 'P', confidence: 0.58 },
    { file: 3, rank: 4, piece: 'B', confidence: 0.62 },
  ],
  orientation: 'white',
  modelVersion: '0.9.3',
});

let installed = false;
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
      await new Promise((r) => setTimeout(r, 80));
      return new Response(UNRELIABLE_BODY, {
        status: 422,
        headers: { 'content-type': 'application/json' },
      });
    }
    return original(input, init);
  };
}

export function DevBoardImageDropzoneUnreliablePage() {
  installFetchMock();
  const [open, setOpen] = useState(true);
  const [appliedFen, setAppliedFen] = useState<string | null>(null);

  return (
    <div style={{ maxWidth: 880, margin: '24px auto', padding: 16 }}>
      <h1>KS-3093 — recognition_unreliable → Board Editor</h1>
      <p style={{ color: '#888', marginBottom: 16 }}>
        Открываем SetPositionModal на вкладке «From image». Любая
        загрузка картинки → мок 422 с fenAttempt (a1 = P, должно быть R).
        После «распознавания» модалка автоматически переключается на
        Board Editor — там правим фигуры кликом / меняем рокировку /
        side-to-move и применяем.
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
          data-testid="dev-board-image-dropzone-unreliable-applied"
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
