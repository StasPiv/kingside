/**
 * KS-4394 / ADR-137 T2 §2.5. Подсчёт времени чтения.
 *
 * Зеркалит формулу, по которой `vite-blog-plugin.mjs` считает
 * `readingTimeMin` на build-этапе — рантайм-утилита нужна для двух
 * сценариев:
 *   1. Превью локального черновика (`draft: true`), который в индексе
 *      отсутствует и `readingTimeMin` неоткуда взять.
 *   2. Юнит-тесты: build-плагин — `.mjs` без типов; здесь — типизированная
 *      реализация для проверки формулы.
 *
 * Параметры зеркалят `WPM` из плагина: 200 wpm для русского, 250 — для
 * английского. Минимум 1 минута. Округление вверх.
 */
import type { BlogLocale } from '../../types/blog';

/** Скорость чтения по локали, слов в минуту. */
export const READING_WPM: Readonly<Record<BlogLocale, number>> = {
  ru: 200,
  en: 250,
};

/** Удаляет markdown-разметку, чтобы счёт слов не считал `#`/`*`/код. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_~-]+/g, ' ');
}

/** Чистое количество слов в произвольном тексте. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Сколько минут читать markdown-текст в указанной локали.
 *   - Подсчёт слов после `stripMarkdown` (код/изображения/линки
 *     нормализуются), деление на WPM локали, округление вверх.
 *   - Минимум 1 минута даже для пустого текста — UI должен показывать
 *     осмысленное число.
 *   - Неизвестная локаль фолбэчится на среднее (220 wpm).
 */
export function readingTime(text: string, locale: BlogLocale): number {
  const words = countWords(stripMarkdown(text));
  const wpm = READING_WPM[locale] ?? 220;
  return Math.max(1, Math.ceil(words / wpm));
}
