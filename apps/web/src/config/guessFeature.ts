/**
 * KS-3412 → KS-3413 (ADR-086, guess-the-move). Гейт точки входа фичи
 * «угадай ход» (роут `/guess` + кнопка на ArchiveGamePage).
 *
 * F1+F2+F3+L1 готовы — связка выкатывается единым релизом. Гейт ВКЛЮЧЁН
 * (`true`): /guess и кнопка видны в проде. Изначально стоял
 * `import.meta.env.DEV`, чтобы случайный деплой по другой задаче не
 * выкатил недоделанную фичу; финальный reveal — флип на true.
 *
 * Дальнейшая эволюция: при добавлении backend'ом `guessEnabled` в
 * whitelist FeatureFlags — заменить на `useFeatureFlag('guessEnabled')`
 * для возможности рантайм-отключения админом без редеплоя.
 */
export const GUESS_ENTRY_ENABLED = true;
