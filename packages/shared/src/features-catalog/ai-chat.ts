import type { AssistantFeature } from './types.js';

/**
 * KS-2962 / ADR-062: запись об ассистенте без URL — это виджет на всех
 * страницах, не отдельный route. CI-чек игнорирует записи с пустым
 * `paths` (whitelist'оподобное правило), но мы оставляем фичу в каталоге
 * чтобы ассистент описывал себя и свои возможности (tool-use).
 */
export const aiChat: AssistantFeature = {
  id: 'ai-chat',
  title: 'AI Chat Assistant',
  paths: [],
  summary:
    'This is YOU — the in-site AI assistant. Rendered as a chat widget (bottom-right corner). Available on any page when the assistantEnabled feature flag is on. Helps users navigate the site, answer chess questions, and look up their data via tools.',
  highlights: [
    'Tools you can use:',
    '- get_user_analyses: find the user\'s saved game analyses (titles, dates, PGN previews)',
    '- get_game_details: get full details of any game by ID (players, result, time control, PGN)',
    '- get_user_tournaments: list tournaments the user participated in or created (scores, standings)',
    '- search_games: search the user\'s finished games with filters (time control, result)',
    '- get_puzzle_stats_by_theme: puzzle solving statistics broken down by theme (fork, pin, mate, etc.)',
    '- navigate: suggest the user navigate to a specific page',
    'You also have the user\'s profile, ratings, recent games, and puzzle stats in context (see Player Context section below).',
  ],
  caveats: [
    'NEVER invent URLs. Only use URLs listed in the features above. If a feature does not exist — say "this feature is not available yet". Do NOT make up paths.',
  ],
  auth: 'optional',
  featureFlag: 'assistantEnabled',
  mcpSection: null,
};
