import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SetPositionModal } from '../components/SetPositionModal';

/**
 * KS-3117 dev-песочница для multi-board режима. Mock'ает `fetch` →
 * 200 с массивом `boards` (4 разные позиции). Используется для
 * скриншотов и ручной проверки UI выбора в BoardImageDropzone.
 *
 * `?autoload=1` — программно эмулирует загрузку картинки через
 * `input[type=file]` (interact не умеет setInputFiles).
 */

const SINGLE_BOARD = {
  fen: '6b1/kK3r2/3pQ1np/4N3/2Pp4/3P2PP/PP2Q1BK/4R3 w - - 0 1',
  fenBoard: '6b1/kK3r2/3pQ1np/4N3/2Pp4/3P2PP/PP2Q1BK/4R3',
  orientation: 'white',
  orientationConfidence: 0.95,
  bbox: [10, 10, 320, 320],
  modelVersion: '2.0.0',
  lowConfidenceCells: [],
  warnings: [],
};

function buildMultiBoardsPayload() {
  // Mock 4-х досок из учебника / страницы пазлов. Все валидные позиции
  // (1 wK + 1 bK), разные debutы — чтобы превью визуально отличались.
  const boards = [
    {
      ...SINGLE_BOARD,
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1',
      fenBoard: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      bbox: [10, 10, 200, 200],
    },
    {
      ...SINGLE_BOARD,
      fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/2N5/PPPP1PPP/R1BQKBNR w - - 0 1',
      fenBoard: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/2N5/PPPP1PPP/R1BQKBNR',
      bbox: [220, 10, 410, 200],
    },
    {
      ...SINGLE_BOARD,
      fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
      fenBoard: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R',
      bbox: [10, 220, 200, 410],
    },
    {
      ...SINGLE_BOARD,
      fen: 'r1bqkbnr/ppp2ppp/2n5/1B1pp3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
      fenBoard: 'r1bqkbnr/ppp2ppp/2n5/1B1pp3/4P3/5N2/PPPP1PPP/RNBQK2R',
      bbox: [220, 220, 410, 410],
    },
  ];
  // Корневые поля — копия первой доски (back-compat, см. KS-3117 контракт).
  return JSON.stringify({ ...boards[0], boards });
}

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
      await new Promise((r) => setTimeout(r, 100));
      return new Response(buildMultiBoardsPayload(), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return original(input, init);
  };
}

function autoLoadFakeFile() {
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

export function DevBoardImageDropzoneMultiPage() {
  installFetchMock();
  const [open, setOpen] = useState(true);
  const [appliedFen, setAppliedFen] = useState<string | null>(null);
  const [searchParams] = useSearchParams();

  const handleAutoload = useCallback(() => autoLoadFakeFile(), []);

  useEffect(() => {
    if (!open) return;
    if (searchParams.get('autoload') !== '1') return;
    const t = setTimeout(() => autoLoadFakeFile(), 700);
    return () => clearTimeout(t);
  }, [open, searchParams]);

  return (
    <div style={{ maxWidth: 880, margin: '24px auto', padding: 16 }}>
      <h1>KS-3117 — multi-board recognition</h1>
      <p style={{ color: '#888', marginBottom: 16 }}>
        Mock recognizer возвращает 200 с массивом из 4 досок. После
        загрузки UI BoardImageDropzone показывает grid превью; клик по
        карточке — выбор доски и переход в InlineBoardEditor.
      </p>
      <button
        type="button"
        onClick={handleAutoload}
        style={{ marginBottom: 12 }}
      >
        Auto-load test image
      </button>
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
        >
          <strong>Applied:</strong>
          <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
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
