import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SetPositionModal } from '../components/SetPositionModal';

/**
 * KS-3120 dev-песочница. Mock'ает `fetch` → 500 для проверки нового
 * defensive-поведения: вместо `mock: network: board-recognition: HTTP 500`
 * со стартовой позицией пользователь получает crop-overlay с понятным
 * сообщением (BoardNotDetectedError из KS-3094).
 *
 * `?autoload=1` для interact-скриншотов.
 */

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
      return new Response('Internal server error', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
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

export function DevBoardImageDropzone500Page() {
  installFetchMock();
  const [open, setOpen] = useState(true);
  const [searchParams] = useSearchParams();

  useEffect(() => {
    if (!open) return;
    if (searchParams.get('autoload') !== '1') return;
    const t = setTimeout(() => autoLoadFakeFile(), 700);
    return () => clearTimeout(t);
  }, [open, searchParams]);

  return (
    <div style={{ maxWidth: 880, margin: '24px auto', padding: 16 }}>
      <h1>KS-3120 — HTTP 500 → BoardNotDetectedError → crop-overlay</h1>
      <p style={{ color: '#888', marginBottom: 16 }}>
        Mock recognizer возвращает 500. Раньше пользователь видел
        `mock: network: board-recognition: HTTP 500` со стартовой
        позицией. Теперь — crop-overlay с понятным сообщением.
      </p>
      {open && (
        <SetPositionModal
          initialTab="image"
          onApply={() => setOpen(false)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
