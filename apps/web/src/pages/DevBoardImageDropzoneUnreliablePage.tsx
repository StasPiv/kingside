import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SetPositionModal } from '../components/SetPositionModal';

/**
 * KS-3093 / KS-3094 / KS-3095: автозагрузка тестовой картинки —
 * для MCP `interact`, который не умеет setInputFiles. Делает программный
 * change на `input[type=file]` через DataTransfer, чтобы пройти стандартный
 * `onChange` обработчик BoardImageDropzone без какой-либо смены логики.
 *
 * Используется только в dev-роутах /dev/board-image-dropzone* — вне их
 * не подгружается (tree-shake через `import.meta.env.DEV` в App.tsx).
 */
function autoLoadFakeFile() {
  // 1x1 прозрачный PNG (минимально валидный, ML-моку всё равно — мы
  // мокаем fetch на уровне страницы).
  const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
  const bin = atob(PNG_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], 'autoload-test.png', { type: 'image/png' });
  const input = document.querySelector<HTMLInputElement>(
    'input[data-testid="board-image-dropzone-file-input"]',
  );
  if (!input) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

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

function buildUnreliableBody(
  orientation: 'white' | 'black',
  scenario: 'pawn-on-edge' | 'multi-king',
): string {
  // KS-3105/KS-3106: scenario определяет какую жалобу эмулируем:
  // - 'pawn-on-edge' (default) — пешка на a1, формат {file,rank,piece}.
  // - 'multi-king' — два белых короля (точная репродукция KS-3106),
  //   формат {square, predicted} как реально отдаёт прод-backend.
  if (scenario === 'multi-king') {
    return JSON.stringify({
      error: 'recognition_unreliable',
      message: 'sanity check failed',
      // Из жалобы KS-3106: пользователь видел 2 белых короля в FEN
      // `6b1/kK3r2/3pQ1np/4N3/2Pp4/3P2PP/PP2Q1BK/4R3 w - - 0 1`.
      // Два K: b7 и h2.
      fenAttempt:
        '6b1/kK3r2/3pQ1np/4N3/2Pp4/3P2PP/PP2Q1BK/4R3 w - - 0 1',
      issues: [
        'exactly one white king required',
        'low confidence: 3 cells',
      ],
      // Реальный prod-формат: {square, predicted, confidence, top3}.
      lowConfidenceCells: [
        { square: 'a8', predicted: 'empty', confidence: 0.41, top3: [] },
        { square: 'd5', predicted: 'wP', confidence: 0.55, top3: [] },
        { square: 'f5', predicted: 'empty', confidence: 0.6, top3: [] },
      ],
      orientation,
      modelVersion: '0.9.5',
    });
  }
  return JSON.stringify({
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
    orientation,
    modelVersion: '0.9.3',
  });
}

let installed = false;
let currentOrientation: 'white' | 'black' = 'white';
let currentScenario: 'pawn-on-edge' | 'multi-king' = 'pawn-on-edge';
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
      return new Response(
        buildUnreliableBody(currentOrientation, currentScenario),
        {
          status: 422,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return original(input, init);
  };
}

export function DevBoardImageDropzoneUnreliablePage() {
  installFetchMock();
  const [open, setOpen] = useState(true);
  const [appliedFen, setAppliedFen] = useState<string | null>(null);
  const [searchParams] = useSearchParams();

  // KS-3105: `?orientation=black` — сценарий «картинка снята со стороны
  // чёрных», редактор должен быть перевёрнут.
  currentOrientation = searchParams.get('orientation') === 'black' ? 'black' : 'white';
  // KS-3106: `?scenario=multi-king` — реальный prod-формат
  // `{square, predicted}` + sanity-violation вида «two white kings».
  currentScenario = searchParams.get('scenario') === 'multi-king' ? 'multi-king' : 'pawn-on-edge';

  // `?autoload=1` — для MCP `interact` (не умеет setInputFiles). Ждём
  // 700мс чтобы модал успел отрисовать input[type=file], затем
  // эмулируем выбор файла.
  useEffect(() => {
    if (!open) return;
    if (searchParams.get('autoload') !== '1') return;
    const t = setTimeout(() => autoLoadFakeFile(), 700);
    return () => clearTimeout(t);
  }, [open, searchParams]);

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
