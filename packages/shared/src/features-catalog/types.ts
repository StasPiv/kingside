import type { FeatureFlagKey } from '../types/feature-flags.js';

/**
 * KS-2966 / ADR-063 §5 — slim features-catalog для AI-ассистента.
 *
 * Источник правды коротких описаний разделов сайта для system-prompt'а.
 * Раньше (ADR-062, KS-2962) содержал длинные `highlights` и `caveats` —
 * именно там скапливались выдуманные факты, которые ловил архитектор в
 * KS-2964. После Phase 1 (KS-2966) поля удалены: остаётся только то,
 * что верифицируется автоматически — paths (CI-чек path-diff), auth,
 * featureFlag, mcpSection, плюс одно короткое предложение `summary`
 * (≤200 символов, что это и зачем). Детальные ответы ассистент будет
 * доставать через MCP knowledge-tools (Phase 2, KS-2967).
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
   * Одно короткое предложение (≤200 символов, EN), отвечающее на «что
   * это и зачем». Без перечисления механик и без URL — детали ассистент
   * достанет через knowledge-tools (Phase 2). CI-валидация:
   *   - длина в диапазоне [30..200];
   *   - заканчивается точкой;
   *   - не содержит `{siteUrl}` или прямых URL;
   *   - не повторяется текст между записями.
   */
  summary: string;

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
