import { useCallback } from 'react';

/**
 * KS-2621 (ADR-052 §3.3.2 #2). Минимальный hook для копирования текста
 * в буфер обмена с fallback'ом для старых браузеров и не-secure
 * контекстов (где `navigator.clipboard` недоступен).
 *
 * Контракт: `copy(text) => Promise<boolean>` — `true` если что-то
 * скопировалось (через clipboard API или через временный textarea +
 * `document.execCommand('copy')`); `false` — если оба пути упали (тогда
 * вызывающее место может показать пользователю ручную плашку «скопируй
 * сам» или error-toast).
 *
 * Hook-обёртка вокруг pure-функции `copyTextToClipboard` нужна, чтобы
 * callsite получил стабильный callback под `useCallback`-deps без
 * лишних импортов из utils.
 */

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through на execCommand-fallback */
    }
  }
  // Fallback для старых браузеров / http-окружений: создаём скрытый
  // <textarea>, выделяем содержимое, вызываем execCommand('copy').
  // execCommand формально deprecated, но это единственный синхронный
  // способ копирования без user-prompt'а в legacy-средах.
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

export function useCopyToClipboard(): (text: string) => Promise<boolean> {
  return useCallback((text: string) => copyTextToClipboard(text), []);
}
