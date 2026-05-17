import { useTranslation } from 'react-i18next';
import type { EngineErrorReason } from '../hooks/useStockfish';
import './EngineLoader.css';

type EngineLoaderProps = {
  /** Текущее состояние движка (`useStockfish`/`useEngine`). */
  state: string;
  /** 0..1, доля загруженного wasm. */
  loadProgress: number;
  /** Причина ошибки — определяет какой текст показать. */
  errorReason: EngineErrorReason;
  /** Колбэк «Попробовать снова» — вызывает `init()` хука. */
  onRetry: () => void;
  /** `inline` — компактная плашка внутри карточки; `block` — крупная по центру. */
  variant?: 'inline' | 'block';
  /** Дополнительный CSS-класс на корневой контейнер. */
  className?: string;
};

/**
 * KS-3067. UI индикатор загрузки/ошибки шахматного движка. Заменяет немой
 * спиннер на странице анализа, наблюдения партии и тренажёрах. Без него
 * пользователь на медленной мобильной сети видит крутящийся спиннер и
 * через 30 секунд просто получает «не работает» — кейс с другом
 * пользователя на Xiaomi из KS-3063.
 *
 * - `state === 'loading'` → прогресс-бар + проценты;
 * - `state === 'error'`   → понятное сообщение по `errorReason` + кнопка
 *   «Попробовать снова».
 *
 * На остальных состояниях возвращает `null` — родитель сам рендерит
 * нормальный контент (eval, доска, и т.д.).
 */
export function EngineLoader({
  state,
  loadProgress,
  errorReason,
  onRetry,
  variant = 'block',
  className,
}: EngineLoaderProps) {
  const { t } = useTranslation();

  if (state !== 'loading' && state !== 'error') return null;

  const rootClass = ['engine-loader', `engine-loader--${variant}`, className]
    .filter(Boolean)
    .join(' ');

  if (state === 'loading') {
    const pct = Math.max(0, Math.min(1, loadProgress));
    return (
      <div className={rootClass} data-testid="engine-loader-loading" role="status" aria-live="polite">
        <div className="engine-loader__title">{t('engine.loader.loadingTitle')}</div>
        <div className="engine-loader__bar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} role="progressbar">
          <div
            className="engine-loader__bar-fill"
            style={{ width: `${pct * 100}%` }}
          />
        </div>
        <div className="engine-loader__percent">{Math.round(pct * 100)}%</div>
        <div className="engine-loader__hint">{t('engine.loader.loadingHint')}</div>
      </div>
    );
  }

  // state === 'error'
  const messageKey: string =
    errorReason === 'no_coi'
      ? 'engine.loader.errorNoCoi'
      : errorReason === 'load_failed'
      ? 'engine.loader.errorLoadFailed'
      : errorReason === 'init_timeout'
      ? 'engine.loader.errorInitTimeout'
      : 'engine.loader.errorGeneric';

  return (
    <div className={rootClass} data-testid="engine-loader-error" role="alert">
      <div className="engine-loader__title engine-loader__title--error">
        {t('engine.loader.errorTitle')}
      </div>
      <div className="engine-loader__text">{t(messageKey)}</div>
      {/* `no_coi` не лечится повторной попыткой — кнопку скрываем. */}
      {errorReason !== 'no_coi' && (
        <button
          type="button"
          className="engine-loader__retry"
          onClick={onRetry}
          data-testid="engine-loader-retry"
        >
          {t('engine.loader.retry')}
        </button>
      )}
    </div>
  );
}
