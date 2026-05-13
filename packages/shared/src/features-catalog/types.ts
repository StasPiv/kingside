import type { FeatureFlagKey } from '../types/feature-flags.js';

/**
 * KS-2962 / ADR-062 §5 — каталог фич для AI-ассистента.
 *
 * Источник истины описания разделов сайта для system-prompt'а. Записи
 * рендерятся `renderFeaturesBlock` в `apps/api/src/ai-chat/system-prompt.ts`.
 * CI-чек `tools/check-features-catalog.mjs` сверяет union `paths[]` со
 * списком `<Route path="...">` в `apps/web/src/App.tsx`.
 */
export interface AssistantFeature {
  /**
   * Стабильный машинный id раздела (kebab-case). Используется в логах,
   * тестах и для cross-ref с `@McpModule({section})` (ADR-061 §3).
   * Совпадение id с MCP-section — желательно, но не обязательно: не все
   * UI-разделы имеют backend-секцию (например, `analysis` работает на
   * WASM-Stockfish без бэкенда).
   */
  id: string;

  /**
   * Заголовок раздела для системного промта (EN, пока ассистент EN).
   * Появляется в промте как `### {title} ({paths.join(', ')})`.
   */
  title: string;

  /**
   * Пути в react-router. Параметризованные через `:param`. Перечислять
   * ВСЕ пути, которые относятся к этому разделу. Каждый путь должен
   * реально существовать в `apps/web/src/App.tsx` — проверяет CI-чек.
   *
   * НЕ перечислять системные пути (`/login`, `/admin/*`, `/dev/*`,
   * `/oauth/callback`, redirects). Они в whitelist'е CI-чека и НЕ
   * должны попадать в каталог.
   */
  paths: string[];

  /**
   * Краткое назначение раздела (1-3 предложения, EN). Отвечает на
   * вопрос «что это и когда сюда идти». Детальные правила — в
   * `highlights`. Минимум 30 символов (валидируется CI-чеком).
   */
  summary: string;

  /**
   * Опциональные буллеты с ключевыми возможностями раздела. EN.
   * Рекомендованная длина — до 8 пунктов; больше — модель не запомнит.
   * Шаблонная подстановка `{siteUrl}` поддерживается.
   */
  highlights?: string[];

  /**
   * Ограничения / технические оговорки. EN. Примеры:
   *  - «Requires authentication»
   *  - «Max 3 active bot games at a time»
   *  - «Engine runs locally (WebAssembly) — no server needed»
   */
  caveats?: string[];

  /**
   * Требуется ли авторизация. Подсказка ассистенту: предлагать раздел
   * гостям только если `auth !== 'user'`.
   *  - 'user'     — `<ProtectedRoute>` на всех путях
   *  - 'public'   — гости видят
   *  - 'optional' — некоторые подпути защищены, остальные нет
   */
  auth: 'user' | 'public' | 'optional';

  /**
   * Имя runtime feature flag из `FeatureFlagsService`. `null` — раздел
   * включён всегда. Если флаг задан — описание ВСЁ РАВНО попадает в
   * промт, но с пометкой «available only when the {featureFlag}
   * feature flag is enabled». Текущее значение флага ассистент видит
   * через `FeatureFlagsSnapshot`, пробрасываемый в `buildSystemPrompt`.
   */
  featureFlag: FeatureFlagKey | null;

  /**
   * Связанные ADR для трассировки. Опционально. Пример:
   * `['ADR-047', 'ADR-048']` для Precision. В промт не попадают —
   * только для разработчиков.
   */
  adr?: string[];

  /**
   * Связь с MCP-секцией (`@McpModule({section})` из ADR-061). `null` —
   * раздел чисто клиентский / не имеет backend-секции. Если задан —
   * CI-чек дополнительно проверяет (опционально, при наличии
   * `KINGSIDE_API_URL`+`MCP_DISCOVERY_KEY`), что такая секция
   * существует в `/_mcp/tools`.
   */
  mcpSection: string | null;
}

/**
 * Snapshot значений runtime feature flags, пробрасываемый в
 * `buildSystemPrompt` для рендера блока «Availability» на флаговых
 * фичах. Получается из `FeatureFlagsService.getFlags()`.
 */
export type FeatureFlagsSnapshot = Record<FeatureFlagKey, boolean>;
