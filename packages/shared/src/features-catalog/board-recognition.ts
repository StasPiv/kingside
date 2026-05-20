import type { AssistantFeature } from './types.js';

/**
 * KS-3168 / ADR-071 §3.1 — cross-cutting capability «фото/скрин доски →
 * FEN». Запись в каталоге без route (`paths: []`), как `ai-chat.ts`:
 * фича не имеет собственной страницы, а встроена в Analysis (`/analysis`,
 * SetPositionModal) и Archive position-search (`/archive`,
 * SetPositionModal). На сервере — `POST /api/board-recognition` под
 * `JwtAuthGuard`; на фронте — `BoardImageDropzone` внутри SetPositionModal.
 *
 * Доступность на проде определяется наличием ENV `BOARD_RECOG_MODEL_
 * VERSION` (без неё endpoint отвечает 503). См. ADR-040.
 */
export const boardRecognition: AssistantFeature = {
  id: 'board-recognition',
  title: 'Board recognition (image → FEN)',
  paths: [],
  summary:
    'Cross-cutting capability that converts a board photo or screenshot to a FEN string; available inside Analysis and Archive position search when a recognition model is installed.',
  auth: 'user',
  featureFlag: null,
  adr: ['ADR-040'],
  mcpSection: null,
};
