import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalysisListItem } from '@kingside/shared';

import { api } from '../../api';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import {
  LiveAnalysisApiError,
  switchLiveAnalysis,
} from '../../api/liveAnalysisApi';

/**
 * KS-4628 / ADR-142 §2.9. UI тренера: popover «Переключить окно анализа».
 *
 * Кнопка-toggle открывает popover с (1) текущим активным окном вверху
 * (отмечено ✓, кликабельность отключена), (2) списком последних
 * открытых `Analysis`, (3) полем поиска (debounce 200 мс). Клик по
 * элементу → `POST /live-analyses/:slug/switch-analysis` → toast
 * «Переключено: <title>». Доска у тренера обновится автоматически
 * через broadcast'нутый `live-analysis:sync` snapshot (см.
 * `useLiveAnalysisBroadcast`); компонент сам никаких локальных
 * стейтов доски не трогает.
 *
 * Источник списка — `GET /analyses?limit=20[&search=]`. По ADR-142 MVP
 * (§2.9): «recent + поиск», без отдельной таблицы плейлистов.
 *
 * Поведение ошибок:
 *   - `LiveAnalysisApiError(code=forbidden_*|tree_too_large|...)` →
 *     toast с локализованным текстом. После toast popover не закрывается,
 *     чтобы тренер мог поправить и повторить.
 *   - network/5xx → generic-toast «Не удалось переключить окно».
 *
 * Доступ:
 *   - Рендерится только когда `slug !== null` (трансляция активна) и
 *     текст пользователя — owner. Родитель решает, рендерить или нет.
 */
export interface LectureAnalysisSwitcherProps {
  /** Slug активной трансляции. Без него switcher не имеет смысла. */
  slug: string;
  /**
   * UUID `Analysis`, который сейчас активен — для подсветки ✓ в
   * popover'е. `null` — лекция без привязки к Analysis либо первый
   * `sync` ещё не пришёл. Источник — `LiveAnalysisSyncSnapshot.activeAnalysisId`.
   */
  activeAnalysisId?: string | null;
  /**
   * Заголовок текущего активного окна — для подписи «Сейчас в эфире:
   * <title>» в шапке popover'а. Источник — `LiveAnalysisSyncSnapshot.activeTitle`.
   */
  activeTitle?: string | null;
  /** Дополнительный класс для контейнера. */
  className?: string;
}

export function LectureAnalysisSwitcher({
  slug,
  activeAnalysisId = null,
  activeTitle = null,
  className,
}: LectureAnalysisSwitcherProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [analyses, setAnalyses] = useState<AnalysisListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [toast, setToast] = useState<
    { kind: 'ok' | 'error'; text: string } | null
  >(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ── Загрузка списка при открытии popover'а / смене запроса ──────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const q = debouncedSearch.trim();
    const url =
      q.length > 0
        ? `/analyses?limit=20&offset=0&search=${encodeURIComponent(q)}`
        : `/analyses?limit=20&offset=0`;
    setLoading(true);
    api
      .get<AnalysisListItem[]>(url)
      .then((res) => {
        if (cancelled) return;
        setAnalyses(res);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : String(err ?? 'unknown'),
        );
        setAnalyses([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debouncedSearch]);

  // ── Автофокус на поиск при открытии popover'а ───────────────────────
  useEffect(() => {
    if (open) {
      // Дожидаемся следующего тика, чтобы input оказался в DOM.
      const id = setTimeout(() => searchInputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [open]);

  // ── Закрытие popover'а по клику вне и по Escape ─────────────────────
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const container = containerRef.current;
      if (!container) return;
      if (e.target instanceof Node && container.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // ── Авто-исчезающий toast ───────────────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const handleSwitch = useCallback(
    async (item: AnalysisListItem) => {
      if (switchingId) return;
      if (item.id === activeAnalysisId) return;
      setSwitchingId(item.id);
      setLoadError(null);
      try {
        // KS-4628: MVP — отправляем только `analysisId`. Backend сам
        // подтянет `tree`/`startingFen`/`orientation`/`title` из
        // `Analysis` (см. ADR-142 §2.6: «если поле опущено, backend
        // берёт значение из Analysis в БД»). Передавать сериализованное
        // дерево с клиента можно — но требует распарсить PGN тренера,
        // а это отдельная работа (KS-3780-style serializeLiveTree).
        // Для MVP достаточно analysisId — все switch'и через picker
        // выбирают «целый» Analysis из БД, у которого есть pgn и fen.
        await switchLiveAnalysis(slug, { analysisId: item.id });
        setToast({
          kind: 'ok',
          text: t('lectureSwitcher.toastSwitched', 'Switched: {{title}}', {
            title: item.title,
          }),
        });
        setOpen(false);
      } catch (err) {
        const code =
          err instanceof LiveAnalysisApiError ? err.code : 'unknown';
        // Маппинг кодов → ключи i18n. Дефолтный fallback — generic.
        const i18nKey = `lectureSwitcher.error.${code}`;
        const fallback =
          code === 'forbidden_analysis'
            ? 'You can only switch to your own analyses.'
            : code === 'tree_too_large'
              ? 'The analysis is too large to switch.'
              : code === 'not_found'
                ? 'Broadcast not found or already closed.'
                : 'Failed to switch the analysis window.';
        setToast({ kind: 'error', text: t(i18nKey, fallback) });
      } finally {
        setSwitchingId(null);
      }
    },
    [activeAnalysisId, slug, switchingId, t],
  );

  const list = useMemo(() => analyses ?? [], [analyses]);

  return (
    <div
      ref={containerRef}
      className={['lecture-analysis-switcher', className]
        .filter(Boolean)
        .join(' ')}
      data-testid="lecture-analysis-switcher"
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="lecture-analysis-switcher-toggle"
        aria-expanded={open}
        aria-haspopup="listbox"
        style={{
          padding: '6px 12px',
          borderRadius: 6,
          border: '1px solid #1976d2',
          background: open ? '#1976d2' : '#fff',
          color: open ? '#fff' : '#1976d2',
          fontSize: 13,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span aria-hidden="true">▾</span>
        {t('lectureSwitcher.toggle', 'Switch analysis window')}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('lectureSwitcher.dialogAria', 'Switch analysis window')}
          data-testid="lecture-analysis-switcher-popover"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            zIndex: 30,
            width: 320,
            maxWidth: 'calc(100vw - 32px)',
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxHeight: 'min(70vh, 480px)',
          }}
        >
          {activeTitle && (
            <div
              data-testid="lecture-analysis-switcher-active"
              style={{
                fontSize: 12,
                color: '#555',
                padding: '4px 6px',
                background: '#f4f8ff',
                border: '1px solid #c8d8f5',
                borderRadius: 4,
              }}
            >
              <span style={{ color: '#1976d2', marginRight: 4 }}>✓</span>
              {t('lectureSwitcher.activeHint', 'Now live: {{title}}', {
                title: activeTitle,
              })}
            </div>
          )}

          <input
            ref={searchInputRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t(
              'lectureSwitcher.searchPlaceholder',
              'Search my analyses…',
            )}
            data-testid="lecture-analysis-switcher-search"
            aria-label={t(
              'lectureSwitcher.searchAria',
              'Search my analyses',
            )}
            style={{
              padding: '6px 10px',
              fontSize: 13,
              border: '1px solid #ccc',
              borderRadius: 4,
              outline: 'none',
              width: '100%',
              boxSizing: 'border-box',
            }}
          />

          <div
            role="listbox"
            data-testid="lecture-analysis-switcher-list"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              border: '1px solid #eee',
              borderRadius: 4,
            }}
          >
            {loading && (
              <div
                data-testid="lecture-analysis-switcher-loading"
                style={{
                  padding: '12px',
                  fontSize: 13,
                  color: '#888',
                  textAlign: 'center',
                }}
              >
                {t('lectureSwitcher.loading', 'Loading…')}
              </div>
            )}
            {!loading && loadError && (
              <div
                data-testid="lecture-analysis-switcher-load-error"
                role="alert"
                style={{
                  padding: '12px',
                  fontSize: 13,
                  color: '#8a1f1f',
                }}
              >
                {t(
                  'lectureSwitcher.loadError',
                  'Failed to load analyses list.',
                )}
              </div>
            )}
            {!loading && !loadError && list.length === 0 && (
              <div
                data-testid="lecture-analysis-switcher-empty"
                style={{
                  padding: '12px',
                  fontSize: 13,
                  color: '#888',
                  textAlign: 'center',
                }}
              >
                {search.trim().length > 0
                  ? t(
                      'lectureSwitcher.emptySearch',
                      'No analyses match your search.',
                    )
                  : t(
                      'lectureSwitcher.emptyAll',
                      'You have no saved analyses yet.',
                    )}
              </div>
            )}
            {!loading &&
              !loadError &&
              list.map((item) => {
                const isActive = item.id === activeAnalysisId;
                const isSwitching = switchingId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    disabled={isActive || isSwitching || !!switchingId}
                    onClick={() => handleSwitch(item)}
                    data-testid="lecture-analysis-switcher-item"
                    data-analysis-id={item.id}
                    data-active={isActive ? 'true' : 'false'}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      background: isActive ? '#f4f8ff' : '#fff',
                      border: 'none',
                      borderBottom: '1px solid #f0f0f0',
                      cursor:
                        isActive || isSwitching ? 'default' : 'pointer',
                      fontSize: 13,
                      color: isActive ? '#1976d2' : '#222',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    {isActive && (
                      <span
                        aria-hidden="true"
                        style={{ color: '#1976d2', flexShrink: 0 }}
                      >
                        ✓
                      </span>
                    )}
                    <span
                      style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.title}
                    </span>
                    {isSwitching && (
                      <span
                        data-testid="lecture-analysis-switcher-item-spinner"
                        style={{ fontSize: 11, color: '#888' }}
                      >
                        {t('lectureSwitcher.switching', 'Switching…')}
                      </span>
                    )}
                  </button>
                );
              })}
          </div>
        </div>
      )}

      {toast && (
        <div
          role={toast.kind === 'error' ? 'alert' : 'status'}
          data-testid="lecture-analysis-switcher-toast"
          data-toast-kind={toast.kind}
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 9998,
            padding: '10px 16px',
            borderRadius: 6,
            background: toast.kind === 'ok' ? '#1976d2' : '#8a1f1f',
            color: '#fff',
            fontSize: 13,
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            maxWidth: 'calc(100vw - 32px)',
          }}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
