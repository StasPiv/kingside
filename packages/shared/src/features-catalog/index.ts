/**
 * KS-2962 / ADR-062 — каталог фич для AI-ассистента.
 *
 * `FEATURES` — единственный источник истины описания UI-разделов
 * сайта для system-prompt'а. Порядок записей фиксирован — он же
 * порядок в собранном промте (детерминированный output, предсказуемый
 * diff в PR).
 *
 * Импортируется в:
 *  - `apps/api/src/ai-chat/system-prompt.ts` — для рендера блока
 *    «Site pages and features».
 *  - `tools/check-features-catalog.mjs` — для сверки с `App.tsx`.
 *  - (опционально) `apps/web` — для генерации nav-меню / sitemap.
 */

import type { AssistantFeature } from './types.js';

import { home } from './home.js';
import { play } from './play.js';
import { activeGame } from './active-game.js';
import { gamesLive } from './games-live.js';
import { puzzles } from './puzzles.js';
import { puzzleRush } from './puzzle-rush.js';
import { precision } from './precision.js';
import { mistakes } from './mistakes.js';
import { analysis } from './analysis.js';
import { workshop } from './workshop.js';
import { drills } from './drills.js';
import { lessons } from './lessons.js';
import { tournaments } from './tournaments.js';
import { broadcasts } from './broadcasts.js';
import { players } from './players.js';
import { friends } from './friends.js';
import { messages } from './messages.js';
import { profile } from './profile.js';
import { settings } from './settings.js';
import { feedback } from './feedback.js';
import { archive } from './archive.js';
import { trainLobby } from './train-lobby.js';
import { analyzeLobby } from './analyze-lobby.js';
import { docs } from './docs.js';
import { aiChat } from './ai-chat.js';

export * from './types.js';

export const FEATURES: readonly AssistantFeature[] = [
  home,
  play,
  activeGame,
  gamesLive,
  puzzles,
  puzzleRush,
  precision,
  mistakes,
  analysis,
  workshop,
  drills,
  lessons,
  tournaments,
  broadcasts,
  players,
  friends,
  messages,
  profile,
  settings,
  feedback,
  archive,
  trainLobby,
  analyzeLobby,
  docs,
  aiChat,
] as const;
