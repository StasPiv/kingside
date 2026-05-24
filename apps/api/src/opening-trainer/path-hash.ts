import { createHash } from 'node:crypto';

/**
 * KS-3288 (M2 §2.5 ADR-077). Стабильный короткий идентификатор UCI-пути
 * от корня репертуара до точки замера.
 *
 * Формат: hex sha1 от `pathUci.join('|')`. SHA-1 даёт 40-char hex —
 * приемлемая длина для UNIQUE-индекса. Коллизии практически невозможны
 * (дерево репертуара ≤ 5000 edges).
 *
 * Разделитель `|` выбран потому что валидные UCI содержат только
 * `a-h0-8qrbn` — никаких `|` в данных нет.
 */
export function pathHash(pathUci: ReadonlyArray<string>): string {
  return createHash('sha1').update(pathUci.join('|')).digest('hex');
}
