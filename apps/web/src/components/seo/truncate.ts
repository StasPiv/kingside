// KS-4175 / ADR-128 §7.6.1.1.A: утилита для SEO-обрезки строк по слову.
// Используется компонентом <SeoHelmet> для гарантии лимитов поисковиков
// (title ≤ 60, description ≤ 160). Усечение по последнему пробелу до
// границы, чтобы не рвать слово на середине. Если в пределах лимита
// пробела нет вообще (одно длинное слово/идентификатор) — режем
// посимвольно. Лимит включает символ многоточия «…».

/**
 * Обрезает строку до `limit` символов, сохраняя целостность последнего
 * слова. Возвращает исходную строку, если она и так короче лимита.
 *
 * @param str   исходная строка
 * @param limit максимальная длина результата, включая многоточие
 */
export function truncateByWord(str: string, limit: number): string {
  if (!str) return str;
  if (limit <= 1) return str.slice(0, Math.max(0, limit));
  if (str.length <= limit) return str;

  // Резервируем 1 символ под «…»
  const head = str.slice(0, limit - 1);
  const lastSpace = head.lastIndexOf(' ');

  if (lastSpace > 0) {
    return head.slice(0, lastSpace).trimEnd() + '…';
  }

  // Пробелов нет — режем посимвольно
  return head + '…';
}
