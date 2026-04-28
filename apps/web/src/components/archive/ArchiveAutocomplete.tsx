import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

/**
 * KS-2067 (F1 / ADR-033 §4.4): универсальный autocomplete для архива.
 *
 * Используется и для поиска игроков (`ArchivePlayerAutocomplete`),
 * и для поиска турниров/событий (`ArchiveEventAutocomplete`). Логика
 * одинаковая (debounce 250ms, минимум 2 символа, dropdown с
 * результатами, ранжирование берёт сам бэк по `gamesCount`), а
 * различия — только в loader'е и в форматировании item'а.
 *
 * Состояния:
 *  - idle (q < MIN_LEN) — dropdown скрыт.
 *  - loading — короткий «Loading…» в dropdown'е.
 *  - empty — «Ничего не найдено» (только если q >= MIN_LEN и сервер
 *    вернул пустой `items`, не loading).
 *  - data — список результатов.
 *  - error — «Не удалось загрузить» (без блокировки ввода).
 */

const DEBOUNCE_MS = 250;
const MIN_LEN = 2;

export interface ArchiveAutocompleteItem {
  /** Строка-id для key/select. У игроков — slug, у событий — slug. */
  id: string;
  /** Отображаемое имя/название. */
  label: string;
  /** Метка-метаданные справа (gamesCount, peakElo, диапазон лет — на усмотрение конкретного консумера). */
  meta?: string;
}

interface ArchiveAutocompleteProps {
  /** Текущее значение (поднимается наверх — например, в форму). */
  value: string;
  /** Обновление текстового значения (вызывается на каждое изменение input). */
  onChange: (value: string) => void;
  /** Колбэк выбора item'а из dropdown'а. */
  onSelect: (item: ArchiveAutocompleteItem) => void;
  /** Loader: q (>= MIN_LEN) → массив items. Должен быть стабильным
      (useCallback в родителе), иначе debounce перерасчитывается. */
  loader: (q: string) => Promise<ArchiveAutocompleteItem[]>;
  /** Placeholder. */
  placeholder?: string;
  /** Подпись (рендерится внутри `<label>`). */
  label?: string;
  /** Test-id префикс — передаётся, чтобы соседи в одной форме различались. */
  testIdPrefix: string;
  /** Дополнительный className. */
  className?: string;
  /**
   * KS-2092: колбэк на Enter, когда в dropdown'е НЕТ подсвеченного
   * item'а (`activeIdx === -1`). Используется для chips-полей: если
   * пользователь напечатал имя, dropdown пуст / не выбран — Enter
   * добавляет raw-значение как chip. Если не передан — Enter без
   * выбора игнорируется (поведение по умолчанию).
   */
  onEnterUnselected?: (rawValue: string) => void;
}

export function ArchiveAutocomplete({
  value,
  onChange,
  onSelect,
  loader,
  placeholder,
  label,
  testIdPrefix,
  className,
  onEnterUnselected,
}: ArchiveAutocompleteProps) {
  const { t } = useTranslation('archive');
  const [items, setItems] = useState<ArchiveAutocompleteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);

  const listboxId = useId();

  // ─── Debounced fetch ─────────────────────────────────────────────
  useEffect(() => {
    const trimmed = value.trim();
    // Меньше MIN_LEN — закрываем dropdown и сбрасываем состояние.
    if (trimmed.length < MIN_LEN) {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      setItems([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      const seq = ++requestSeqRef.current;
      setLoading(true);
      setError(null);
      loader(trimmed)
        .then((res) => {
          // KS-2067: race-protection — отбрасываем устаревшие ответы
          // (если за время debounce пришёл новый запрос).
          if (seq !== requestSeqRef.current) return;
          setItems(res);
          setLoading(false);
        })
        .catch((e: Error) => {
          if (seq !== requestSeqRef.current) return;
          setItems([]);
          setError(e.message);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [value, loader]);

  // ─── Закрытие при клике снаружи ─────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
    setOpen(true);
    setActiveIdx(-1);
  };

  const handleFocus = () => {
    if (value.trim().length >= MIN_LEN) setOpen(true);
  };

  const handleSelect = useCallback(
    (item: ArchiveAutocompleteItem) => {
      onSelect(item);
      setOpen(false);
      setActiveIdx(-1);
    },
    [onSelect],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((idx) => Math.min(idx + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((idx) => Math.max(idx - 1, 0));
    } else if (e.key === 'Enter') {
      if (activeIdx >= 0 && activeIdx < items.length) {
        e.preventDefault();
        handleSelect(items[activeIdx]);
      } else if (onEnterUnselected) {
        // KS-2092: dropdown пуст или ничего не подсвечено — отдаём
        // сырое значение наверх (родитель добавит как chip).
        const raw = value.trim();
        if (raw.length > 0) {
          e.preventDefault();
          onEnterUnselected(raw);
        }
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActiveIdx(-1);
    }
  };

  const trimmedLen = value.trim().length;
  const showDropdown = open && trimmedLen >= MIN_LEN;

  return (
    <div
      ref={containerRef}
      className={`archive-autocomplete${className ? ` ${className}` : ''}`}
      data-testid={`${testIdPrefix}-root`}
    >
      {label && (
        <label
          className="archive-games-filters__label"
          htmlFor={`${testIdPrefix}-input`}
        >
          {label}
        </label>
      )}
      <input
        id={`${testIdPrefix}-input`}
        type="text"
        className="archive-games-filters__input"
        value={value}
        placeholder={placeholder}
        onChange={handleInputChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showDropdown}
        aria-controls={listboxId}
        data-testid={`${testIdPrefix}-input`}
      />
      {showDropdown && (
        <ul
          id={listboxId}
          role="listbox"
          className="archive-autocomplete__dropdown"
          data-testid={`${testIdPrefix}-dropdown`}
        >
          {loading && (
            <li
              role="option"
              aria-disabled="true"
              aria-selected="false"
              className="archive-autocomplete__hint"
              data-testid={`${testIdPrefix}-loading`}
            >
              {t('lobby.autocomplete.loading', 'Loading…')}
            </li>
          )}
          {!loading && error && (
            <li
              role="option"
              aria-disabled="true"
              aria-selected="false"
              className="archive-autocomplete__hint archive-autocomplete__hint--error"
              data-testid={`${testIdPrefix}-error`}
            >
              {t('lobby.autocomplete.error', 'Could not load suggestions')}
            </li>
          )}
          {!loading && !error && items.length === 0 && (
            <li
              role="option"
              aria-disabled="true"
              aria-selected="false"
              className="archive-autocomplete__hint"
              data-testid={`${testIdPrefix}-empty`}
            >
              {t('lobby.autocomplete.empty', 'Nothing found')}
            </li>
          )}
          {!loading &&
            !error &&
            items.map((item, idx) => (
              <li
                key={item.id}
                role="option"
                aria-selected={idx === activeIdx}
                className={`archive-autocomplete__item${idx === activeIdx ? ' archive-autocomplete__item--active' : ''}`}
                onMouseDown={(e) => {
                  // mousedown, чтобы успеть выбрать до того, как
                  // input потеряет фокус (blur закрыл бы dropdown).
                  e.preventDefault();
                  handleSelect(item);
                }}
                onMouseEnter={() => setActiveIdx(idx)}
                data-testid={`${testIdPrefix}-item-${item.id}`}
              >
                <span className="archive-autocomplete__label">{item.label}</span>
                {item.meta && (
                  <span className="archive-autocomplete__meta">{item.meta}</span>
                )}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
