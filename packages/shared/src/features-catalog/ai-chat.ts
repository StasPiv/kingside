import type { AssistantFeature } from './types.js';

/**
 * KS-2962 / ADR-062: запись об ассистенте без URL — это виджет на всех
 * страницах, не отдельный route. CI-чек игнорирует записи с пустым
 * `paths` (whitelist'оподобное правило), но мы оставляем фичу в каталоге
 * чтобы ассистент описывал себя и свои возможности (tool-use).
 *
 * KS-2966 / ADR-063 §5: длинный список tools и инструкций вынесен из
 * каталога — детали ассистент достаёт через MCP knowledge-tools
 * (Phase 2, KS-2967) или из STATIC_FOOTER system-prompt'а.
 */
export const aiChat: AssistantFeature = {
  id: 'ai-chat',
  title: 'AI Chat Assistant',
  paths: [],
  summary:
    'This is YOU — the in-site AI assistant rendered as a chat widget; you help users navigate the site and look up their data via tools.',
  auth: 'optional',
  featureFlag: 'assistantEnabled',
  mcpSection: null,
};
