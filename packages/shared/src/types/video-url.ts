/**
 * Shared whitelist и helper для проверки URL-ов в `VideoStepPayload`
 * (L-34 / KS-1796 / KS-1808).
 *
 * Используется:
 *  - на бэке — `VideoStepPayloadDto` (class-validator) и seed-линтер
 *    (`apps/api/src/lessons/seed/lint.ts`), чтобы невалидный `url`
 *    отбивался и в рантайме API, и при прогоне `npm run seed:lessons:lint`;
 *  - на фронте — `apps/web/src/components/lessons/steps/VideoStep.tsx`
 *    использует тот же словарь при рендере iframe.
 *
 * В whitelist попадают только те хосты, для которых у нас подтверждённый
 * embed-сценарий (YouTube / Vimeo). Protocol — строго `http:` / `https:`:
 * любые схемы вида `javascript:`, `data:`, `file:` отбиваются.
 */

/**
 * Whitelist допустимых хостов для `VideoStepPayload.url`.
 * Элементы сравниваются с `new URL(url).hostname` регистронезависимо.
 */
export const ALLOWED_VIDEO_HOSTS: readonly string[] = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'vimeo.com',
  'www.vimeo.com',
  'player.vimeo.com',
] as const;

/**
 * Проверить, что `url` — строка, парсится как URL, использует `http:` /
 * `https:` и принадлежит одному из whitelist-хостов. Ничего не бросает —
 * всегда возвращает булев ответ (удобно для class-validator `validator`).
 *
 * Не нормализует URL (не убирает лишние параметры / trailing slash) —
 * это задача фронта в зависимости от сценария рендера.
 */
export function isAllowedVideoUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_VIDEO_HOSTS.includes(host);
}
