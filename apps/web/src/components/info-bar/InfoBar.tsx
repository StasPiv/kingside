import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import './InfoBar.css';

/**
 * KS-4815. Глобальная информационная полоса под header'ом.
 *
 * Узкий канал для системных сообщений на любой странице: контекстные
 * подсказки, общие уведомления (в будущем — maintenance/release-notes
 * и пр.). Один активный entry в каждый момент — last write wins.
 *
 * Каждый publisher (например, `<HintHost>`) пушит свой entry через
 * `useInfoBar().push(...)` и снимает через `clear(id)`. `clear`
 * принимает `id` и снимает запись только если она ещё текущая — это
 * защищает от гонки, когда два publisher'а быстро сменили друг друга.
 *
 * Provider mount'ится в `<MainLayout>` один раз на сессию; `<InfoBar />`
 * рендерится сразу под `<header>`. Если активного entry нет — `<InfoBar />`
 * возвращает `null`, в DOM ничего не добавляет.
 */

export interface InfoBarEntry {
  /** Уникальный идентификатор entry — используется для безопасного `clear`. */
  id: string;
  /** Короткий заголовок (всегда есть). */
  title: string;
  /** Расширенный текст (опционально). */
  body?: string;
  /** Опциональная CTA-кнопка. */
  cta?: { label: string; onClick: () => void };
  /** Обработчик крестика «закрыть». Без него крестик не рендерится. */
  onDismiss?: () => void;
  /** Опциональный testid (для разных типов entry — подсказки / системные). */
  testid?: string;
  /** Дополнительные data-* атрибуты на корневом контейнере. */
  dataAttrs?: Record<string, string>;
}

interface InfoBarApi {
  entry: InfoBarEntry | null;
  push: (entry: InfoBarEntry) => void;
  clear: (id: string) => void;
}

const InfoBarContext = createContext<InfoBarApi | null>(null);

export function InfoBarProvider({ children }: { children: ReactNode }): ReactElement {
  const [entry, setEntry] = useState<InfoBarEntry | null>(null);

  const push = useCallback((next: InfoBarEntry) => {
    setEntry(next);
  }, []);

  const clear = useCallback((id: string) => {
    setEntry((cur) => (cur && cur.id === id ? null : cur));
  }, []);

  return (
    <InfoBarContext.Provider value={{ entry, push, clear }}>
      {children}
    </InfoBarContext.Provider>
  );
}

export function useInfoBar(): InfoBarApi {
  const ctx = useContext(InfoBarContext);
  if (!ctx) {
    throw new Error('useInfoBar must be used within <InfoBarProvider>');
  }
  return ctx;
}

export function InfoBar(): ReactElement | null {
  const ctx = useContext(InfoBarContext);
  if (!ctx?.entry) return null;
  const { entry } = ctx;

  return (
    <div
      className="info-bar"
      role="status"
      aria-live="polite"
      data-testid={entry.testid ?? 'info-bar'}
      {...(entry.dataAttrs ?? {})}
    >
      <div className="info-bar__inner">
        <div className="info-bar__content">
          <span className="info-bar__title">{entry.title}</span>
          {entry.body && <span className="info-bar__body">{entry.body}</span>}
        </div>
        <div className="info-bar__actions">
          {entry.cta && (
            <button
              type="button"
              className="info-bar__cta"
              onClick={entry.cta.onClick}
              data-testid="info-bar-cta"
            >
              {entry.cta.label}
            </button>
          )}
          {entry.onDismiss && (
            <button
              type="button"
              className="info-bar__close"
              aria-label="Close"
              onClick={entry.onDismiss}
              data-testid="info-bar-close"
            >
              ×
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
