import { useState } from 'react';
import { BoardImageDropzone } from '../components/BoardImageDropzone';
import { BoardRecognitionUnreliableError } from '../api/boardRecognition';

/**
 * KS-3093 dev-песочница. Жёстко мокает `recognizer` так, что ЛЮБАЯ
 * загрузка картинки даёт 422 `recognition_unreliable` c тем самым
 * fenAttempt из задачи (a1 = пешка вместо ладьи). Нужна для
 * playwright-скриншота acceptance-flow без живого backend'а:
 *
 *   1. дроп файла → дропзона ловит unreliable-ответ;
 *   2. на доске нарисована позиция из fenAttempt (видно P на a1);
 *   3. warning-плашка с issues;
 *   4. подсвечен lowConfidenceCell (a1);
 *   5. «Edit FEN manually» активен, после правки P→R Apply
 *      разблокируется.
 *
 * Доступна по `/dev/board-image-dropzone-unreliable`. Tree-shake'ается
 * из prod-сборки вместе с остальными DevRoutes (KS-1821).
 */

const UNRELIABLE_PAYLOAD = {
  error: 'recognition_unreliable' as const,
  message: 'sanity check failed',
  // Точно из жалобы пользователя в задаче: модель распознала всё кроме
  // a1, где нарисована пешка (должна быть ладья R).
  fenAttempt:
    'r2q1rk1/ppp1b1pp/1nn1pP2/5b2/2PP4/2N1BN2/PP2B1PP/P2Q1RK1 w - - 0 1',
  issues: ['some pawns are on the edge rows'],
  lowConfidenceCells: [
    { file: 0, rank: 7, piece: 'P', confidence: 0.51 },
    { file: 5, rank: 2, piece: 'P', confidence: 0.58 },
    { file: 3, rank: 4, piece: 'B', confidence: 0.62 },
  ],
  orientation: 'white' as const,
  modelVersion: '0.9.3',
};

async function mockRecognizer(): Promise<never> {
  // Маленькая задержка, чтобы UI успел показать `Recognizing…` —
  // снимок для отчёта будет содержательнее.
  await new Promise((r) => setTimeout(r, 80));
  throw new BoardRecognitionUnreliableError(UNRELIABLE_PAYLOAD);
}

export function DevBoardImageDropzoneUnreliablePage() {
  const [appliedFen, setAppliedFen] = useState<string | null>(null);
  return (
    <div style={{ maxWidth: 880, margin: '24px auto', padding: 16 }}>
      <h1>KS-3093 — BoardImageDropzone 422-flow</h1>
      <p style={{ color: '#888', marginBottom: 16 }}>
        Любая загрузка картинки → мок 422 `recognition_unreliable` c
        тем самым fenAttempt (a1 = P, должно быть R) и issues
        `[pawns on the edge rows]`. Используется для playwright-скрина.
      </p>
      <BoardImageDropzone
        onAccept={(fen) => setAppliedFen(fen)}
        recognizer={mockRecognizer}
      />
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
    </div>
  );
}
