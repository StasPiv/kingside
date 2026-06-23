import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import type { Locale, User } from '@kingside/shared';
import { useSounds, SOUND_THEMES, previewSound, type SoundTheme } from '../hooks/useSounds';
import {
  useBoardSettings,
  BOARD_THEMES,
  PIECE_SETS,
  NAV_AUTO_REPEAT_MS_MIN,
  NAV_AUTO_REPEAT_MS_MAX,
  NAV_AUTO_REPEAT_MS_STEP,
  type BoardThemeId,
  type PieceSetId,
} from '../hooks/useBoardSettings';
// KS-3600: ELO Maia переехал из engine-panel в общие настройки.
import {
  MAIA_ELO_OPTIONS,
  useMaiaEloSetting,
} from '../hooks/useMaiaAnalysis';
import {
  useGameReviewMovetime,
  MIN_MOVETIME_MS,
  MAX_MOVETIME_MS,
} from '../hooks/useGameReviewMovetime';
import { HelpButton } from '../components/HelpButton';
import { resetDrillOnboarding } from '../utils/drillOnboarding';
// KS-2423: drill-only mute для звуков тренажёров.
import { useDrillSounds } from '../hooks/useDrillSounds';

/**
 * KS-4565 / ADR-141. Страница `/settings` группирована по 4 вкладкам:
 *
 *   account — Профиль · Внешние аккаунты · Заблокированные игроки
 *   board   — Тема · Набор фигур · Анимация · Автопревращение · Скорость авто-перемотки
 *   game    — Уровень Maia · Время на ход разбора · Отладочная панель движка бота
 *   interface — Язык · Звук (общий + тема + предпрослушка) · Тренажёры
 *
 * URL — `?tab=account|board|game|interface`. Последняя выбранная
 * вкладка хранится в `localStorage['settings.lastTab']` — при открытии
 * `/settings` без `?tab=...` восстанавливается. Первая загрузка —
 * `account`. См. ADR §2.2.
 */

const TAB_ORDER = ['account', 'board', 'game', 'interface'] as const;
type SettingsTab = (typeof TAB_ORDER)[number];

const LAST_TAB_STORAGE_KEY = 'settings.lastTab';

function isValidTab(v: string | null): v is SettingsTab {
  return v != null && (TAB_ORDER as readonly string[]).includes(v);
}

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { user, refreshUser } = useAuth();
  const { muted, toggleMute, theme: soundTheme, setTheme: setSoundThemeState } = useSounds();
  const {
    boardTheme,
    pieceSet,
    selectTheme,
    selectPieceSet,
    autoPromoteToQueen,
    setAutoPromoteToQueen,
    navAutoRepeatMs,
    setNavAutoRepeatMs,
  } = useBoardSettings();
  // KS-3600: уровень Maia для анализа. Persist в localStorage
  // `analysis.maia.elo`, дефолт 1500.
  const { elo: maiaElo, setElo: setMaiaElo } = useMaiaEloSetting();
  // KS-3617: время на ход для «Разобрать партию», дефолт 1000 мс.
  const { movetimeMs: reviewMovetimeMs, setMovetimeMs: setReviewMovetimeMs } =
    useGameReviewMovetime();

  const [blocked, setBlocked] = useState<{ id: string; username: string }[]>([]);
  const [chesscomUsername, setChesscomUsername] = useState('');
  const [lichessUsername, setLichessUsername] = useState('');
  const [externalSaving, setExternalSaving] = useState(false);
  const [externalStatus, setExternalStatus] = useState<string | null>(null);

  // KS-4312: переключатель «Показывать отладочную панель движка бота».
  // Источник — серверное поле `user.showBotEngineDebugPanel`, изменения
  // через `PATCH /users/me/settings`. После запроса вызываем
  // `refreshUser()` чтобы AuthContext подтянул свежее значение.
  const showBotEngineDebugPanel = !!user?.showBotEngineDebugPanel;
  const [debugPanelSaving, setDebugPanelSaving] = useState(false);
  const handleToggleBotEngineDebugPanel = useCallback(
    async (next: boolean) => {
      setDebugPanelSaving(true);
      try {
        await api.patch('/users/me/settings', {
          showBotEngineDebugPanel: next,
        });
        await refreshUser();
      } catch (err) {
        console.warn('[settings] PATCH showBotEngineDebugPanel failed', err);
      } finally {
        setDebugPanelSaving(false);
      }
    },
    [refreshUser],
  );

  useEffect(() => {
    api.get<{ data: { id: string; username: string }[] }>('/users/blocked')
      .then(({ data }) => setBlocked(data))
      .catch(() => {});
    api.get<{ chesscomUsername?: string; lichessUsername?: string }>('/users/me/settings')
      .then((data) => {
        if (data.chesscomUsername) setChesscomUsername(data.chesscomUsername);
        if (data.lichessUsername) setLichessUsername(data.lichessUsername);
      })
      .catch(() => {});
  }, []);

  const handleSaveExternalAccounts = async () => {
    setExternalSaving(true);
    setExternalStatus(null);
    try {
      await api.patch('/users/me/external-accounts', {
        chesscomUsername: chesscomUsername.trim() || null,
        lichessUsername: lichessUsername.trim() || null,
      });
      setExternalStatus(t('settings.externalSaved', 'Saved'));
    } catch {
      setExternalStatus(t('settings.externalError', 'Failed to save'));
    } finally {
      setExternalSaving(false);
    }
  };

  const handleUnblock = useCallback(async (userId: string) => {
    try {
      await api.delete(`/users/unblock/${userId}`);
      setBlocked((prev) => prev.filter((b) => b.id !== userId));
    } catch { /* ignore */ }
  }, []);

  const [animationDuration, setAnimationDuration] = useState<number>(() => {
    const saved = localStorage.getItem('pieceAnimationDuration');
    return saved !== null ? parseInt(saved, 10) : 200;
  });

  // KS-2418: сброс факта показа онбординг-подсказок в drill'ах. После
  // нажатия — короткое уведомление в той же области (исчезает само).
  const [drillsOnboardingMsg, setDrillsOnboardingMsg] = useState<string | null>(null);
  const handleResetDrillsOnboarding = () => {
    resetDrillOnboarding();
    setDrillsOnboardingMsg(t('settings.drills.resetOnboardingDone'));
    setTimeout(() => setDrillsOnboardingMsg(null), 4000);
  };

  // KS-2423: drill-only mute. Глобальный mute остаётся в секции «Звук»;
  // здесь добавляем точечный — пользователь может оставить звуки в
  // обычной игре и убрать только в тренажёрах (и наоборот).
  const { drillMuted, toggleDrillMuted } = useDrillSounds();

  const handleAnimationChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = parseInt(e.target.value, 10);
    setAnimationDuration(value);
    localStorage.setItem('pieceAnimationDuration', String(value));
  };

  const handleLanguageChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const locale = e.target.value as Locale;
    // KS-2102: PATCH ПЕРВЫМ. Бэкенд (KS-2101) после KS-2101 берёт
    // язык курсов из `User.locale`, поэтому до PATCH /lessons
    // ответил бы старой локалью. После успешного PATCH меняем
    // i18n.language — это триггерит рефетч на страницах курсов.
    try {
      await api.patch('/users/me/settings', { locale });
    } catch (err) {
      console.warn('[locale] PATCH /users/me/settings failed', err);
    }
    await i18n.changeLanguage(locale);
    localStorage.setItem('locale', locale);
  };

  // KS-4565 / ADR-141 §2.2. Активная вкладка — из URL `?tab=...`.
  // Если параметр невалиден или отсутствует — пытаемся восстановить из
  // localStorage; иначе дефолт `account`. Запись в localStorage —
  // только при пользовательской смене вкладки через `setTab` (см. ниже).
  //
  // KS-4569: ранее запись в localStorage и синхронизация URL делались
  // через `useEffect`'ы на mount. В тестах это вызывало предупреждения
  // «An update to SettingsPage inside a test was not wrapped in act(...)»
  // и нестабильный cleanup: между тестами в один document.body
  // монтировалось несколько экземпляров → `getByTestId` падал с «Found
  // multiple elements». Логику оставляем синхронной — состояние пишется
  // в момент пользовательского действия, а не в фоне после рендера.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: SettingsTab = useMemo(() => {
    if (isValidTab(tabParam)) return tabParam;
    if (typeof window !== 'undefined') {
      try {
        const saved = window.localStorage.getItem(LAST_TAB_STORAGE_KEY);
        if (isValidTab(saved)) return saved;
      } catch { /* localStorage unavailable */ }
    }
    return 'account';
  }, [tabParam]);

  // Если URL пришёл без `?tab=...`, синхронизируем его с восстановленной
  // активной вкладкой — без этого back/forward в браузере не будет
  // работать корректно, а ссылки на конкретную вкладку (share) не
  // получатся осмысленными. `replace: true`, чтобы не плодить лишних
  // записей в history при редиректе.
  //
  // KS-4569: эффект идемпотентен — если URL уже содержит валидный tab,
  // он не вызывает setSearchParams и не триггерит асинхронный re-render
  // (что и было источником нестабильности тестов после KS-4565).
  useEffect(() => {
    if (!isValidTab(tabParam)) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('tab', activeTab);
          return next;
        },
        { replace: true },
      );
    }
  }, [tabParam, activeTab, setSearchParams]);

  const setTab = useCallback(
    (next: SettingsTab) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set('tab', next);
          return params;
        },
        { replace: true },
      );
      // KS-4569: запись в localStorage — синхронно в обработчике клика
      // вместо `useEffect([activeTab])`. Эффект ловил «render after
      // unmount» в тестах (act warning + накопление DOM-инстансов в
      // одном body), а делал он то же самое — сохранял текущую вкладку.
      try {
        window.localStorage.setItem(LAST_TAB_STORAGE_KEY, next);
      } catch { /* ignore — privacy mode и т. п. */ }
    },
    [setSearchParams],
  );

  return (
    <div className="settings-page">
      <h1>
        {t('settings.title')}
        <HelpButton section="customize" />
      </h1>

      {/* KS-4565 / ADR-141 §2.2: переключатель вкладок. Паттерн
          оформления тот же, что у /lessons и /players. */}
      <nav
        className="settings-tabs"
        aria-label={t('settings.tabs.label', 'Settings sections')}
        data-testid="settings-tabs"
      >
        {TAB_ORDER.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`settings-tab${activeTab === tab ? ' active' : ''}`}
            onClick={() => setTab(tab)}
            aria-current={activeTab === tab ? 'page' : undefined}
            data-testid={`settings-tab-${tab}`}
          >
            {t(`settings.tabs.${tab}`)}
          </button>
        ))}
      </nav>

      {activeTab === 'account' && (
        <AccountTab
          user={user}
          chesscomUsername={chesscomUsername}
          setChesscomUsername={setChesscomUsername}
          lichessUsername={lichessUsername}
          setLichessUsername={setLichessUsername}
          externalSaving={externalSaving}
          externalStatus={externalStatus}
          onSaveExternalAccounts={handleSaveExternalAccounts}
          blocked={blocked}
          onUnblock={handleUnblock}
        />
      )}
      {activeTab === 'board' && (
        <BoardTab
          boardTheme={boardTheme}
          pieceSet={pieceSet}
          selectTheme={selectTheme}
          selectPieceSet={selectPieceSet}
          animationDuration={animationDuration}
          onAnimationChange={handleAnimationChange}
          autoPromoteToQueen={autoPromoteToQueen}
          setAutoPromoteToQueen={setAutoPromoteToQueen}
          navAutoRepeatMs={navAutoRepeatMs}
          setNavAutoRepeatMs={setNavAutoRepeatMs}
        />
      )}
      {activeTab === 'game' && (
        <GameTab
          maiaElo={maiaElo}
          setMaiaElo={setMaiaElo}
          reviewMovetimeMs={reviewMovetimeMs}
          setReviewMovetimeMs={setReviewMovetimeMs}
          user={user}
          showBotEngineDebugPanel={showBotEngineDebugPanel}
          debugPanelSaving={debugPanelSaving}
          onToggleBotEngineDebugPanel={handleToggleBotEngineDebugPanel}
        />
      )}
      {activeTab === 'interface' && (
        <InterfaceTab
          language={i18n.language}
          onLanguageChange={handleLanguageChange}
          muted={muted}
          toggleMute={toggleMute}
          soundTheme={soundTheme}
          setSoundThemeState={setSoundThemeState}
          drillMuted={drillMuted}
          toggleDrillMuted={toggleDrillMuted}
          onResetDrillsOnboarding={handleResetDrillsOnboarding}
          drillsOnboardingMsg={drillsOnboardingMsg}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Вкладки
// ─────────────────────────────────────────────────────────────────────

type AccountTabProps = {
  user: User | null;
  chesscomUsername: string;
  setChesscomUsername: (v: string) => void;
  lichessUsername: string;
  setLichessUsername: (v: string) => void;
  externalSaving: boolean;
  externalStatus: string | null;
  onSaveExternalAccounts: () => void;
  blocked: { id: string; username: string }[];
  onUnblock: (id: string) => void;
};

function AccountTab(props: AccountTabProps) {
  const { t } = useTranslation();
  const {
    user,
    chesscomUsername,
    setChesscomUsername,
    lichessUsername,
    setLichessUsername,
    externalSaving,
    externalStatus,
    onSaveExternalAccounts,
    blocked,
    onUnblock,
  } = props;
  return (
    <>
      <section className="settings-section">
        <h2>{t('settings.profile')}</h2>
        <div className="settings-field">
          <label>{t('settings.username')}</label>
          <input type="text" value={user?.username ?? ''} disabled />
        </div>
        <div className="settings-field">
          <label>{t('settings.email')}</label>
          <input type="email" value={user?.email ?? ''} disabled />
        </div>
        {user?.ratingPuzzle != null && (
          <div className="settings-field">
            <span className="settings-label">{t('settings.puzzleRating')}</span>
            <span className="settings-value">{user.ratingPuzzle}</span>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>{t('settings.externalAccounts', 'External Accounts')}</h2>
        <div className="settings-field">
          <label>chess.com</label>
          <input
            type="text"
            value={chesscomUsername}
            onChange={(e) => setChesscomUsername(e.target.value)}
            placeholder={t('settings.externalUsername', 'username')}
          />
        </div>
        <div className="settings-field">
          <label>lichess.org</label>
          <input
            type="text"
            value={lichessUsername}
            onChange={(e) => setLichessUsername(e.target.value)}
            placeholder={t('settings.externalUsername', 'username')}
          />
        </div>
        <button
          onClick={onSaveExternalAccounts}
          disabled={externalSaving}
          style={{ marginTop: 8 }}
        >
          {externalSaving ? t('common.loading') : t('common.save', 'Save')}
        </button>
        {externalStatus && (
          <span
            style={{
              marginLeft: 8,
              fontSize: 12,
              color: externalStatus.includes('Failed')
                ? 'var(--c-ef4444)'
                : 'var(--c-4caf50)',
            }}
          >
            {externalStatus}
          </span>
        )}
      </section>

      <section className="settings-section">
        <h2>{t('settings.blockedPlayers', 'Blocked Players')}</h2>
        {blocked.length === 0 ? (
          <p className="settings-empty">
            {t('settings.noBlocked', 'No blocked players')}
          </p>
        ) : (
          <div className="settings-blocked-list">
            {blocked.map((b) => (
              <div key={b.id} className="settings-blocked-item">
                <Link
                  to={`/player/${b.username}`}
                  className="settings-blocked-name"
                >
                  {b.username}
                </Link>
                <button
                  className="settings-unblock-btn"
                  onClick={() => onUnblock(b.id)}
                >
                  {t('settings.unblock', 'Unblock')}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

type BoardTabProps = {
  boardTheme: BoardThemeId;
  pieceSet: PieceSetId;
  selectTheme: (id: BoardThemeId) => void;
  selectPieceSet: (id: PieceSetId) => void;
  animationDuration: number;
  onAnimationChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  autoPromoteToQueen: boolean;
  setAutoPromoteToQueen: (v: boolean) => void;
  navAutoRepeatMs: number;
  setNavAutoRepeatMs: (v: number) => void;
};

function BoardTab(props: BoardTabProps) {
  const { t } = useTranslation();
  const {
    boardTheme,
    pieceSet,
    selectTheme,
    selectPieceSet,
    animationDuration,
    onAnimationChange,
    autoPromoteToQueen,
    setAutoPromoteToQueen,
    navAutoRepeatMs,
    setNavAutoRepeatMs,
  } = props;
  return (
    <section className="settings-section">
      <h2>{t('settings.board.title', 'Board')}</h2>

      <div
        className="settings-field"
        style={{
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 8,
        }}
      >
        <label>{t('settings.board.themeLabel', 'Board theme')}</label>
        <div className="board-theme-options">
          {BOARD_THEMES.map((theme) => (
            <label
              key={theme.id}
              className={`board-theme-option${
                boardTheme === theme.id ? ' active' : ''
              }`}
              onClick={() => selectTheme(theme.id)}
            >
              <span
                className="board-theme-preview"
                style={{
                  background: `linear-gradient(135deg, ${theme.light} 50%, ${theme.dark} 50%)`,
                }}
              />
              <span className="board-theme-label">
                {/* KS-4568: подписи тем доски (Classic/Green/Blue/Brown)
                    локализованы через labelKey, англоязычный label —
                    fallback для случаев без перевода. */}
                {theme.labelKey ? t(theme.labelKey, theme.label) : theme.label}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div
        className="settings-field"
        style={{
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 8,
          marginTop: 16,
        }}
      >
        <label>{t('settings.board.pieceSetLabel', 'Piece set')}</label>
        <div className="piece-set-options">
          {PIECE_SETS.map((set) => (
            <label
              key={set.id}
              className={`piece-set-option${pieceSet === set.id ? ' active' : ''}`}
              onClick={() => selectPieceSet(set.id)}
              title={
                set.license
                  ? `${set.license.author} — ${set.license.name}`
                  : undefined
              }
            >
              <span className="piece-set-preview">
                {set.id === 'standard' ? (
                  <span style={{ fontSize: 32, lineHeight: 1 }}>&#9822;</span>
                ) : (
                  <img src={`/pieces/${set.id}/wN.svg`} alt={set.label} />
                )}
              </span>
              <span className="piece-set-label">
                {/* KS-4568: для `standard` подпись переводимая; для
                    именованных наборов (Chessnut, Fantasy, ...) labelKey
                    отсутствует — рендерим оригинальный label как имя
                    автора набора. */}
                {set.labelKey ? t(set.labelKey, set.label) : set.label}
              </span>
            </label>
          ))}
        </div>
        {/* KS-3320: ссылка на /credits — атрибуция авторов всех
            piece-sets и их лицензий. Обязательная по требованиям CC BY 4.0
            для kiwen-suwi/firi/totoy и CC BY-SA 4.0 для shapes. */}
        <a
          href="/credits"
          style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}
          data-testid="settings-piece-set-credits-link"
        >
          {t('settings.board.creditsLink', 'Credits and licenses →')}
        </a>
      </div>

      {/* KS-4565 / ADR-141: «Анимация фигур» переехала в эту вкладку,
          т. к. это поведение самой доски. */}
      <div className="settings-field" style={{ marginTop: 16 }}>
        <label htmlFor="animation-select">
          {t('settings.pieceAnimation')}
        </label>
        <select
          id="animation-select"
          value={animationDuration}
          onChange={onAnimationChange}
        >
          <option value={0}>{t('settings.pieceAnimationNone')}</option>
          <option value={100}>{t('settings.pieceAnimationFast')}</option>
          <option value={200}>{t('settings.pieceAnimationNormal')}</option>
        </select>
      </div>

      {/* KS-2970: toggle «Автопревращение в ферзя». Действует только
          в режиме игры. В анализе/пазлах/студиях модалка показывается
          всегда — настройка игнорируется. */}
      <div
        className="settings-field"
        style={{
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 4,
          marginTop: 16,
        }}
        data-testid="settings-auto-promote-queen-field"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id="auto-promote-queen-toggle"
            data-testid="settings-auto-promote-queen-toggle"
            type="checkbox"
            checked={autoPromoteToQueen}
            onChange={(e) => setAutoPromoteToQueen(e.target.checked)}
          />
          <label htmlFor="auto-promote-queen-toggle">
            {t('settings.autoPromoteQueen.label', 'Auto-promote to queen')}
          </label>
        </div>
        <p style={{ fontSize: 13, opacity: 0.75, margin: 0 }}>
          {t(
            'settings.autoPromoteQueen.hint',
            'Game mode only. A pawn reaching the last rank becomes a queen automatically.',
          )}
        </p>
      </div>

      {/* KS-3198 → KS-3415: скорость авто-перемотки при long-press на
          кнопках навигации (`←` / `→` / `⇤` / `⇥`). Ползунок в МС
          (интервал между ходами при удержании), без субъективных
          ярлыков. Меньше мс = быстрее. Сохраняется в localStorage. */}
      <div
        className="settings-field"
        style={{
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 6,
          marginTop: 16,
        }}
        data-testid="settings-nav-auto-repeat-speed-field"
      >
        <label htmlFor="nav-auto-repeat-speed">
          {t('settings.navAutoRepeat.label', 'Move navigation auto-repeat speed')}
        </label>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: '100%',
            maxWidth: 360,
          }}
        >
          <input
            id="nav-auto-repeat-speed"
            type="range"
            data-testid="settings-nav-auto-repeat-speed"
            min={NAV_AUTO_REPEAT_MS_MIN}
            max={NAV_AUTO_REPEAT_MS_MAX}
            step={NAV_AUTO_REPEAT_MS_STEP}
            value={navAutoRepeatMs}
            onChange={(e) => setNavAutoRepeatMs(Number(e.target.value))}
            aria-valuemin={NAV_AUTO_REPEAT_MS_MIN}
            aria-valuemax={NAV_AUTO_REPEAT_MS_MAX}
            aria-valuenow={navAutoRepeatMs}
            style={{ flex: 1 }}
          />
          <span
            data-testid="settings-nav-auto-repeat-speed-value"
            aria-live="polite"
            style={{
              minWidth: 64,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {t('settings.navAutoRepeat.msValue', '{{ms}} ms', {
              ms: navAutoRepeatMs,
            })}
          </span>
        </div>
        <p style={{ fontSize: 13, opacity: 0.75, margin: 0 }}>
          {t(
            'settings.navAutoRepeat.hint',
            'Hold the arrow button to fast-forward through moves. This sets the interval between moves while holding (lower = faster).',
          )}
        </p>
      </div>
    </section>
  );
}

type GameTabProps = {
  maiaElo: number;
  setMaiaElo: (v: number) => void;
  reviewMovetimeMs: number;
  setReviewMovetimeMs: (v: number) => void;
  user: User | null;
  showBotEngineDebugPanel: boolean;
  debugPanelSaving: boolean;
  onToggleBotEngineDebugPanel: (v: boolean) => void;
};

function GameTab(props: GameTabProps) {
  const { t } = useTranslation();
  const {
    maiaElo,
    setMaiaElo,
    reviewMovetimeMs,
    setReviewMovetimeMs,
    user,
    showBotEngineDebugPanel,
    debugPanelSaving,
    onToggleBotEngineDebugPanel,
  } = props;
  return (
    <>
      {/* KS-3600: уровень Maia (анализ) переехал из engine-panel в
          общие настройки — дефолт 1500, persist в localStorage. */}
      <section className="settings-section">
        <h2>{t('settings.maiaLevel.title', 'Maia level (analysis)')}</h2>
        <div className="settings-field">
          <label htmlFor="maia-elo-select">
            {t('settings.maiaLevel.label', 'Maia ELO')}
          </label>
          <select
            id="maia-elo-select"
            data-testid="settings-maia-elo-select"
            value={maiaElo}
            onChange={(e) => setMaiaElo(Number(e.currentTarget.value))}
          >
            {MAIA_ELO_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <p className="settings-hint">
          {t(
            'settings.maiaLevel.hint',
            'Maia uses this rating to predict human moves in the analysis engine panel. Default: 1500.',
          )}
        </p>
      </section>

      {/* KS-3617: время на ход Stockfish для «Разобрать партию». */}
      <section className="settings-section">
        <h2>
          {t('settings.reviewMovetime.title', 'Game review — time per move')}
        </h2>
        <div className="settings-field">
          <label htmlFor="review-movetime-input">
            {t('settings.reviewMovetime.label', 'Seconds per move')}
          </label>
          <input
            id="review-movetime-input"
            data-testid="settings-review-movetime-input"
            type="number"
            min={MIN_MOVETIME_MS / 1000}
            max={MAX_MOVETIME_MS / 1000}
            step={0.1}
            value={(reviewMovetimeMs / 1000).toFixed(1)}
            onChange={(e) =>
              setReviewMovetimeMs(Number(e.currentTarget.value) * 1000)
            }
          />
        </div>
        <p className="settings-hint">
          {t(
            'settings.reviewMovetime.hint',
            'Stockfish time per half-move during “Analyze game”. Default: 1.0 s. Range: {{min}}–{{max}} s.',
            { min: MIN_MOVETIME_MS / 1000, max: MAX_MOVETIME_MS / 1000 },
          )}
        </p>
      </section>

      {/* KS-4312: переключатель «Показывать отладочную панель движка
          бота» — для диагностики проблем с локальным Stockfish в
          партиях с ботом (`isBot=true`). По умолчанию выключен. */}
      <section className="settings-section">
        <h2>{t('settings.botEngineDebugPanel.label', 'Show bot engine debug panel')}</h2>
        <div
          className="settings-field"
          style={{
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 4,
          }}
          data-testid="settings-bot-engine-debug-panel-field"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              id="bot-engine-debug-panel-toggle"
              data-testid="settings-bot-engine-debug-panel-toggle"
              type="checkbox"
              checked={showBotEngineDebugPanel}
              disabled={debugPanelSaving || !user}
              onChange={(e) =>
                void onToggleBotEngineDebugPanel(e.target.checked)
              }
            />
            <label htmlFor="bot-engine-debug-panel-toggle">
              {t(
                'settings.botEngineDebugPanel.label',
                'Show bot engine debug panel',
              )}
            </label>
          </div>
          <p style={{ fontSize: 13, opacity: 0.75, margin: 0 }}>
            {t(
              'settings.botEngineDebugPanel.hint',
              'Diagnostic only. Shows engine events (load, ready, bestmove) above the board in games against a bot.',
            )}
          </p>
        </div>
      </section>
    </>
  );
}

type InterfaceTabProps = {
  language: string;
  onLanguageChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  muted: boolean;
  toggleMute: () => void;
  soundTheme: SoundTheme;
  setSoundThemeState: (v: SoundTheme) => void;
  drillMuted: boolean;
  toggleDrillMuted: () => void;
  onResetDrillsOnboarding: () => void;
  drillsOnboardingMsg: string | null;
};

function InterfaceTab(props: InterfaceTabProps) {
  const { t, i18n } = useTranslation();
  const {
    language,
    onLanguageChange,
    muted,
    toggleMute,
    soundTheme,
    setSoundThemeState,
    drillMuted,
    toggleDrillMuted,
    onResetDrillsOnboarding,
    drillsOnboardingMsg,
  } = props;
  return (
    <>
      <section className="settings-section">
        <h2>{t('settings.language')}</h2>
        <div className="settings-field">
          <select
            id="language-select"
            value={language}
            onChange={onLanguageChange}
          >
            <option value="en">{t('settings.english')}</option>
            <option value="ru">{t('settings.russian')}</option>
          </select>
        </div>
      </section>

      <section className="settings-section">
        <h2>{t('settings.sound')}</h2>
        <div className="settings-field">
          <label htmlFor="sound-toggle">{t('settings.soundEffects')}</label>
          <input
            id="sound-toggle"
            type="checkbox"
            checked={!muted}
            onChange={toggleMute}
          />
        </div>
        {/* KS-2172: выбор звуковой темы. Список из useSounds.SOUND_THEMES,
            сохранение в localStorage через setSoundTheme. Кнопка
            «Прослушать» играет звук move выбранной темы (игнорирует
            mute). */}
        <div className="settings-field">
          <label htmlFor="sound-theme">
            {t('settings.soundTheme.label', 'Sound theme')}
          </label>
          <select
            id="sound-theme"
            value={soundTheme}
            onChange={(e) => setSoundThemeState(e.target.value as SoundTheme)}
            disabled={muted}
          >
            {SOUND_THEMES.map((th) => (
              <option key={th.id} value={th.id}>
                {t(th.nameKey, i18n.language === 'ru' ? th.nameRu : th.nameEn)}
              </option>
            ))}
          </select>
        </div>
        <div
          className="settings-field settings-sound-themes-list"
          style={{
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 6,
          }}
        >
          <span style={{ fontSize: 13, opacity: 0.75 }}>
            {t('settings.soundTheme.previewHint', 'Preview each theme')}
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SOUND_THEMES.map((th) => (
              <button
                key={th.id}
                type="button"
                onClick={() => previewSound(th.id, 'move')}
                aria-label={`${t('settings.soundTheme.preview', 'Preview')}: ${
                  i18n.language === 'ru' ? th.nameRu : th.nameEn
                }`}
                style={{
                  padding: '4px 10px',
                  fontSize: 13,
                  borderRadius: 4,
                  border:
                    th.id === soundTheme
                      ? '2px solid var(--c-4caf50)'
                      : '1px solid var(--c-555)',
                  background: 'var(--c-2a2a2a, #2a2a2a)',
                  color: 'var(--c-fff, #fff)',
                  cursor: 'pointer',
                }}
              >
                ▶ {t(th.nameKey, i18n.language === 'ru' ? th.nameRu : th.nameEn)}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* KS-2418: настройки тренажёров. KS-2423: добавлен toggle
          drill-звуков. Глобальный mute живёт в секции «Звук» выше. */}
      <section
        className="settings-section"
        data-testid="settings-drills-section"
      >
        <h2>{t('settings.drills.heading', 'Drills')}</h2>

        <div className="settings-field">
          <label htmlFor="drills-sound-toggle">
            {t('settings.drills.soundsLabel', 'Drill sound effects')}
          </label>
          <input
            id="drills-sound-toggle"
            data-testid="settings-drills-sound-toggle"
            type="checkbox"
            checked={!drillMuted}
            onChange={toggleDrillMuted}
          />
        </div>
        <p style={{ fontSize: 13, opacity: 0.75, margin: '0 0 12px 0' }}>
          {t(
            'settings.drills.soundsHint',
            'Sounds for square selection, moves, correct/incorrect verdicts and sprint completion. Global sound toggle in the «Sound» section above must also be on.',
          )}
        </p>

        <div
          className="settings-field"
          style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}
        >
          <label className="settings-label">
            {t(
              'settings.drills.resetOnboardingLabel',
              'Drill onboarding tips',
            )}
          </label>
          <p style={{ fontSize: 13, opacity: 0.75, margin: 0 }}>
            {t(
              'settings.drills.resetOnboardingHint',
              'A short description is shown once on the first run of each drill. Reset to see it again.',
            )}
          </p>
          <button
            type="button"
            data-testid="settings-drills-reset-onboarding"
            onClick={onResetDrillsOnboarding}
          >
            {t(
              'settings.drills.resetOnboardingButton',
              'Show tips again',
            )}
          </button>
          {drillsOnboardingMsg && (
            <span
              data-testid="settings-drills-reset-onboarding-status"
              style={{ fontSize: 12, color: 'var(--c-4caf50)' }}
            >
              {drillsOnboardingMsg}
            </span>
          )}
        </div>
      </section>
    </>
  );
}
