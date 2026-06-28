/**
 * KS-4731 / ADR-148. Контракт `data-hint-anchor` — **свободная строка**.
 *
 * Ранее (ADR-147 §4.2) anchor был закрытым enum через `HINT_ANCHORS`
 * union. По ADR-148 это сужение откатано: новое правило `POST /admin/hints`
 * заводится с любым валидным `anchor`-токеном без правки shared и без
 * деплоя — data-driven подход совпадает с тем, как уже работают DSL
 * правил и `event_type`. Фронт читает `[data-hint-anchor="…"]` напрямую
 * по строке, бэк хранит varchar(64) — никакого enum в БД не было и
 * раньше.
 *
 * Что осталось:
 *   - `HintAnchor = string` — тип в публичном API (используется в
 *     `HintShowPayload.anchor`).
 *   - `isValidAnchorFormat(s)` — чистая проверка формата (regex +
 *     длина), без привязки к whitelist. Полезна на стороне frontend
 *     для UX-валидации перед отправкой формы; backend выполняет ту
 *     же проверку через class-validator `@Matches`/`@Length`.
 *
 * Что удалено:
 *   - `HINT_ANCHORS_GUEST`, `HINT_ANCHORS_USER`, `HINT_ANCHORS` —
 *     закрытые списки. Если нужен enum-like вид в админ-UI, тянем
 *     `distinct anchor` из `GET /admin/hints` или из своего справочника
 *     контента.
 *   - `HintAnchorGuest`, `HintAnchorUser` — литеральные типы.
 *   - `isHintAnchor(s)` — type-guard поверх whitelist'а. Заменён на
 *     `isValidAnchorFormat`.
 */

export type HintAnchor = string;

/** Формат токена: lowercase, цифры и дефис; 1..64 символа. */
const ANCHOR_RE = /^[a-z][a-z0-9-]*$/;
const MAX_LEN = 64;

export function isValidAnchorFormat(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_LEN
    && ANCHOR_RE.test(value)
  );
}
