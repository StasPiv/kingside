export * from './types/game.js';
export * from './types/user.js';
export * from './types/puzzle.js';
export * from './types/puzzle-gen.js';
export * from './types/lessons.js';
export * from './types/user-courses.js';
export * from './types/video-url.js';
export * from './types/api-contracts.js';
export * from './types/feature-flags.js';
export * from './types/synthetic.js';
export * from './types/internal-auth.js';
export * from './types/tactic-drill.js';
export * from './synthetic-chat-phrases.js';
export * from './constants.js';
export * from './constants/archive.js';
export * from './utils/time-control.js';
export * from './utils/fen-key.js';
export * from './utils/archive-name-normalize.js';
export * from './utils/wdl.js';
export * from './chess/index.js';
// NB: `./utils/position-key.js` намеренно НЕ реэкспортируется — он тянет `node:crypto`
// и ломает браузерный бандл. Backend (apps/api, apps/archive-service) импортирует
// функцию напрямую: `@kingside/shared/dist/utils/position-key`.
