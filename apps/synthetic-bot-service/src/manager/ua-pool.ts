/**
 * Пул User-Agent строк для anti-detection (ADR-034-v2 §7.3).
 *
 * При создании `BotInstance`'а из пула выбирается один UA, который
 * фиксируется на всю сессию (если ротировать в каждом запросе — это
 * подозрительно само по себе). Браузер не меняет UA в течение визита.
 *
 * Список синхронизируется с реальными currently-popular версиями раз в
 * пару месяцев; обновление — отдельная задача (ADR §7.3).
 */
export const USER_AGENT_POOL: readonly string[] = [
  // Chrome — Mac/Win/Linux
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  // Firefox — Mac/Win/Linux
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  // Safari — только Mac
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  // Edge
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
];

/**
 * Возвращает UA из пула. `random` опционален — позволяет в тестах
 * передать детерминированный seed.
 */
export function pickUserAgent(random: () => number = Math.random): string {
  const idx = Math.floor(random() * USER_AGENT_POOL.length);
  return USER_AGENT_POOL[idx];
}
