import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BoardImageDropzone } from '../components/BoardImageDropzone';

/**
 * KS-2365. Dev-песочница `<BoardImageDropzone>`. Доступна по
 * `/dev/board-image-dropzone` только в dev-сборке (KS-1821 — DevRoutes
 * tree-shake'ается из prod).
 *
 * Назначение:
 *  - Ручная верификация drag&drop / paste / file-input в браузере без
 *    логина и без полной интеграции в Workshop/Lesson editor.
 *  - Backend KS-2363 ещё не задеплоен — клиент `recognizeBoard` отдаёт
 *    мок при 404/network, поэтому полный UI-флоу виден прямо сейчас.
 *  - Используется e2e-тестом `tests/e2e/ks-2365-board-image.spec.ts`
 *    (drag&drop файла → FEN отрисован).
 */
export function DevBoardImageDropzonePage() {
  const { t } = useTranslation();
  const [appliedFen, setAppliedFen] = useState<string | null>(null);

  return (
    <div style={{ maxWidth: 880, margin: '24px auto', padding: 16 }}>
      <h1>KS-2365 — BoardImageDropzone demo</h1>
      <p style={{ color: '#888', marginBottom: 16 }}>
        Drag&amp;drop / paste / file input. Backend KS-2363 ещё не задеплоен —
        клиент <code>recognizeBoard</code> возвращает мок при 404/network.
      </p>

      <BoardImageDropzone onAccept={(fen) => setAppliedFen(fen)} />

      {appliedFen && (
        <div
          style={{ marginTop: 24, padding: 12, background: 'rgba(60,200,120,0.12)', borderRadius: 6 }}
          data-testid="dev-board-image-dropzone-applied"
        >
          <strong>{t('boardImage.apply', 'Apply')}:</strong>
          <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {appliedFen}
          </pre>
        </div>
      )}
    </div>
  );
}
