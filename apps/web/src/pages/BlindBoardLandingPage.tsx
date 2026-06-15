/**
 * KS-3442 (ADR-088 §11 F1) + KS-3488 (V2 §15 F1). Точка входа режима
 * «слепая доска».
 *
 * Маршрут `/blind-board`. Setup-экран с описанием механики, блоком
 * «Настройки сложности» (свёрнут по умолчанию) и кнопкой «Начать» →
 * монтируем `<BlindBoardSessionRunner>` с собранным `config`. Выход
 * обратно на setup-экран — через проп `onExit` (кнопка «Играть ещё»
 * в финале / «Назад» в ошибке).
 *
 * KS-3488: настройки прогрессивной сложности (startPieces / addOrder /
 * memorizeTimeSec) сохраняются в localStorage между запусками для
 * quick-retry. Сводка над кнопкой «Начать» показывает текущий выбор.
 * Кнопка disabled пока config невалиден.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  BLIND_BOARD_LIMITS,
  DEFAULT_BLIND_BOARD_CONFIG,
  type BlindBoardConfig,
} from '@kingside/shared';

import { useAuth } from '../context/AuthContext';
import { BlindBoardSessionRunner } from '../components/blindBoard/BlindBoardSessionRunner';
import { BlindBoardConfigForm } from '../components/blindBoard/BlindBoardConfigForm';
import { BlindBoardSubNav } from '../components/blindBoard/BlindBoardSubNav';
import { PageSeo } from '../components/seo/PageSeo';
import {
  isValidBlindBoardConfig,
  validateBlindBoardConfig,
} from '../components/blindBoard/blindBoardConfigValidation';

const LS_KEY = 'blindBoard:config:v1';

/**
 * Чтение конфига из localStorage с валидацией. Битый / просроченный
 * формат → дефолт. Это безопасно: первый запуск, очистка кеша,
 * обновление контракта (добавление нового поля) — везде вернёмся к
 * рабочему дефолту.
 */
function loadConfigFromLs(): BlindBoardConfig {
  if (typeof window === 'undefined') return DEFAULT_BLIND_BOARD_CONFIG;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_BLIND_BOARD_CONFIG;
    const parsed = JSON.parse(raw) as Partial<BlindBoardConfig>;
    if (
      parsed &&
      Array.isArray(parsed.startPieces) &&
      Array.isArray(parsed.addOrder) &&
      typeof parsed.memorizeTimeSec === 'number'
    ) {
      // KS-3553 (V3): новые поля progressionEnabled / levelDurationRounds.
      // Legacy LS (V2) их не имеет — для бэк-compat подставляем дефолт
      // (`progressionEnabled: true`, `levelDurationRounds: 10`) и
      // проходим валидацию. Это гарантирует, что юзер с сохранённым V2
      // конфигом не получит «битый формат → reset to default».
      const candidate: BlindBoardConfig = {
        startPieces: parsed.startPieces,
        addOrder: parsed.addOrder,
        memorizeTimeSec: parsed.memorizeTimeSec,
        progressionEnabled:
          typeof parsed.progressionEnabled === 'boolean'
            ? parsed.progressionEnabled
            : DEFAULT_BLIND_BOARD_CONFIG.progressionEnabled,
        levelDurationRounds:
          typeof parsed.levelDurationRounds === 'number'
            ? parsed.levelDurationRounds
            : DEFAULT_BLIND_BOARD_CONFIG.levelDurationRounds,
      };
      if (isValidBlindBoardConfig(candidate)) return candidate;
    }
  } catch {
    /* ignore — corrupt JSON, fallback to default */
  }
  return DEFAULT_BLIND_BOARD_CONFIG;
}

function saveConfigToLs(cfg: BlindBoardConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  } catch {
    /* quota exceeded — игнорируем, follow-up без LS работает */
  }
}

/**
 * Краткий summary для свернутого блока.
 * KS-3553 (V3): при выключенной прогрессии addOrder заменяется на
 * локализованный маркер «Без повышения» (передаётся в `noProgression`).
 * Само форматирование чисто строковое — i18n-обёртка живёт в caller'е
 * (BlindBoardLandingPage), здесь только composer.
 */
function configSummary(cfg: BlindBoardConfig, noProgression: string): string {
  const start = cfg.startPieces.join('+') || '∅';
  const middle = cfg.progressionEnabled
    ? cfg.addOrder.join(',') || '∅'
    : noProgression;
  return `${start} / ${middle} / ${cfg.memorizeTimeSec}s`;
}

export function BlindBoardLandingPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [running, setRunning] = useState(false);
  const [config, setConfig] = useState<BlindBoardConfig>(() =>
    loadConfigFromLs(),
  );
  const [showSettings, setShowSettings] = useState(false);

  // KS-4222: document.title больше не подменяем — конфликтует с
  // SeoHelmet/PageSeo, который ставит per-route title через React 19
  // metadata-теги. Старый ручной useEffect оставлял два `<title>` в
  // head после prerender'а.

  useEffect(() => {
    saveConfigToLs(config);
  }, [config]);

  const errors = useMemo(
    () => validateBlindBoardConfig(config),
    [config],
  );
  const valid = errors.length === 0;

  const handleStart = useCallback(() => {
    if (!valid) return;
    setRunning(true);
  }, [valid]);
  const handleExit = useCallback(() => setRunning(false), []);
  const handleRestoreDefaults = useCallback(() => {
    setConfig(DEFAULT_BLIND_BOARD_CONFIG);
  }, []);

  if (running) {
    return (
      <div
        className="blind-board-page"
        data-testid="blind-board-page"
        data-state="playing"
      >
        <div className="blind-board-page__header">
          <button
            type="button"
            className="blind-board-page__back"
            data-testid="blind-board-page-back"
            onClick={handleExit}
          >
            ← {t('blindBoard.setup.back', 'New game')}
          </button>
        </div>
        <BlindBoardSessionRunner config={config} onExit={handleExit} />
      </div>
    );
  }

  return (
    <div
      className="blind-board-page"
      data-testid="blind-board-page"
      data-state="setup"
    >
      <PageSeo ns="blindBoard.list" path="/blind-board" />
      {/* KS-3511: общая sub-nav. */}
      <BlindBoardSubNav />
      {/* KS-4139 / ADR-128 §4: гостю — inline-CTA по образцу
          PuzzlePage. Тренажёр работает локально, статистика на сервер
          не сохраняется. */}
      {!user && (
        <div className="guest-banner" data-testid="blind-board-guest-banner">
          <Link to="/login">
            {t('auth.loginToSaveProgress', 'Sign in to save your progress')}
          </Link>
        </div>
      )}
      <h1 data-testid="blind-board-page-title">
        {t('blindBoard.setup.title', 'Blind board')}
      </h1>
      <p className="blind-board-page__intro">
        {t(
          'blindBoard.setup.intro',
          'Memorize the position from the computer move arrows alone — no pieces are shown. After each computer move tap the square of the moved piece and pick its type. Wrong answer ends the session.',
        )}
      </p>

      {/* KS-3488: блок «Настройки сложности», свёрнут по умолчанию. */}
      <section
        className="blind-board-page__settings"
        data-testid="blind-board-settings"
        data-open={showSettings ? 'true' : 'false'}
      >
        <button
          type="button"
          className="blind-board-page__settings-toggle"
          data-testid="blind-board-settings-toggle"
          aria-expanded={showSettings}
          onClick={() => setShowSettings((v) => !v)}
        >
          <span className="blind-board-page__settings-caret">
            {showSettings ? '▾' : '▸'}
          </span>
          {t('blindBoard.config.title', 'Difficulty settings')}
          <span
            className="blind-board-page__settings-summary"
            data-testid="blind-board-settings-summary"
          >
            {configSummary(
              config,
              t('blindBoard.config.noProgression', 'No progression'),
            )}
          </span>
        </button>
        {showSettings && (
          <div
            className="blind-board-page__settings-body"
            data-testid="blind-board-settings-body"
          >
            <BlindBoardConfigForm value={config} onChange={setConfig} />
            <div className="blind-board-page__settings-actions">
              <button
                type="button"
                className="blind-board-page__settings-restore"
                data-testid="blind-board-settings-restore"
                onClick={handleRestoreDefaults}
              >
                {t(
                  'blindBoard.config.restoreDefaults',
                  'Restore defaults',
                )}
              </button>
            </div>
            {!valid && (
              <p
                className="blind-board-page__settings-error"
                data-testid="blind-board-settings-error"
                role="alert"
              >
                {errors.includes('min-start')
                  ? t(
                      'blindBoard.config.errorMinStart',
                      'Pick at least {{n}} starting pieces.',
                      { n: BLIND_BOARD_LIMITS.minStart },
                    )
                  : errors.includes('max-total')
                    ? t(
                        'blindBoard.config.errorMaxTotal',
                        'Total of starting + add-order pieces cannot exceed {{n}}.',
                        { n: BLIND_BOARD_LIMITS.maxTotal },
                      )
                    : errors.includes('quota')
                      ? t(
                          'blindBoard.config.errorQuota',
                          'Type quota exceeded (Q≤1, R≤2, B≤2, N≤2).',
                        )
                      : t(
                          'blindBoard.config.errorMemorize',
                          'Memorize time must be 3, 5 or 10 seconds.',
                        )}
              </p>
            )}
          </div>
        )}
      </section>

      <button
        type="button"
        className="blind-board-page__start"
        data-testid="blind-board-start"
        onClick={handleStart}
        disabled={!valid}
      >
        {t('blindBoard.setup.start', 'Start')}
      </button>
    </div>
  );
}
