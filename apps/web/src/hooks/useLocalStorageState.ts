/**
 * KS-4035. Общий хук «синхронизированное со `localStorage` состояние».
 *
 * Поведение:
 *  1. На mount пытаемся прочитать значение по `key` из `localStorage`.
 *  2. Если в storage есть валидный JSON и (опциональный) `merge` —
 *     соединяем сохранённое значение с дефолтом (нужен для частичного
 *     восстановления состояния правой колонки анализа, чтобы новые
 *     блоки, добавленные после релиза, получили свой default, а не
 *     `undefined`).
 *  3. На каждое изменение значения — пишем в `localStorage` через
 *     `effect`. Если запись падает (quota / SSR / приватный режим) —
 *     молча игнорируем, в state значение остаётся.
 *
 * Применение:
 *  - `panelStates` в `AnalysisPage` (ключ `ks:analysis-sidebar:collapsed`)
 *    с `merge: (saved, defaults) => ({ ...defaults, ...saved })`;
 *  - `mobileTab` в `AnalysisPage` (ключ `ks:analysis-sidebar:mobile-tab`)
 *    без `merge` — простой string.
 *
 * Хук безопасен на SSR/без `window` — при отсутствии `localStorage` ведёт
 * себя как обычный `useState(initial)` без побочных эффектов.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export interface UseLocalStorageStateOptions<T> {
  /**
   * Соединить сохранённое значение с дефолтом. Используется когда
   * `T` — объект и нужно, чтобы новые поля, появившиеся в коде после
   * сохранения, получили свой default, а не `undefined`. По умолчанию
   * — сохранённое значение используется как есть.
   */
  merge?: (saved: T, defaults: T) => T;
  /** Сериализация. По умолчанию `JSON.stringify`. */
  serialize?: (value: T) => string;
  /** Десериализация. По умолчанию `JSON.parse`. */
  deserialize?: (raw: string) => T;
}

function safeGetItem(key: string): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(key, value);
  } catch {
    /* quota / приватный режим — игнорируем, state живёт без персистенции */
  }
}

export function useLocalStorageState<T>(
  key: string,
  initial: T | (() => T),
  options: UseLocalStorageStateOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>] {
  const serialize = options.serialize ?? JSON.stringify;
  const deserialize =
    options.deserialize ?? ((raw: string) => JSON.parse(raw) as T);
  const merge = options.merge;

  const [state, setState] = useState<T>(() => {
    const defaults =
      typeof initial === 'function' ? (initial as () => T)() : initial;
    const raw = safeGetItem(key);
    if (raw == null) return defaults;
    try {
      const saved = deserialize(raw);
      return merge ? merge(saved, defaults) : saved;
    } catch {
      // Битый JSON — возвращаем default, не падаем.
      return defaults;
    }
  });

  // Запись в localStorage на каждое изменение значения. Через ref
  // запоминаем последнюю записанную сериализацию, чтобы не дёргать
  // storage по таким же значениям (квартирные storage-события).
  const lastSerializedRef = useRef<string | null>(null);
  useEffect(() => {
    try {
      const next = serialize(state);
      if (lastSerializedRef.current === next) return;
      lastSerializedRef.current = next;
      safeSetItem(key, next);
    } catch {
      /* сериализация уронилась — игнорируем */
    }
  }, [key, state, serialize]);

  // Стабильный setter — повторно создавать не нужно, useState уже
  // даёт стабильную ссылку. Но возвращаем именно его, обёртку не
  // добавляем (лишняя память и identity не нужны).
  const setter = useCallback(
    (value: SetStateAction<T>) => setState(value),
    [],
  );
  return [state, setter];
}
