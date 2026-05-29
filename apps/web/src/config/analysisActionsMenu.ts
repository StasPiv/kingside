/**
 * KS-3421 (ADR-087 §8 F1). Гейт нового объединённого меню действий
 * AnalysisPage — `<AnalysisActionsMenu>` с двумя режимами (dropdown
 * на desktop / bottom-sheet на mobile) поверх одного items-source.
 *
 * Гейт сделан build-time константой, а не runtime-флагом, потому что
 * `analysisActionsMenuV2` не заведён в shared `FeatureFlags` (ключ
 * требует синхронной правки бэкенда — packages/shared / config-service).
 * Сейчас флаг ВКЛЮЧЁН: новое меню — основное. Для аварийного отката
 * в течение 1-2 недель (см. ADR-087 §8 F1) — флип на `false` + redeploy.
 *
 * Когда backend добавит `analysisActionsMenuV2` в whitelist FeatureFlags,
 * заменить на `useFeatureFlag('analysisActionsMenuV2')` в caller'е,
 * этот файл удалить.
 */
export const ANALYSIS_ACTIONS_MENU_V2_ENABLED = true;
