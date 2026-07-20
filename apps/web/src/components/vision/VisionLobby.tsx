/**
 * KS-4984 / ADR-167 §7 (задача 3/7). Лобби Vision-тренажёра: выбор
 * режима (1–5 + mixed), длительности Sprint (30/60/120 c) и сложности.
 * По «Начать» отдаёт собранный `VisionSessionConfig` наверх (runner).
 *
 * Стили — задача 5/7 (layout); здесь разметка + data-testid + i18n с
 * дефолтными фолбэками (переводы добавляются отдельно).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  VISION_TIME_MODES,
  type VisionMode,
  type VisionTimeMode,
} from '@kingside/shared';

/** Конфиг сессии, собираемый в лобби. */
export interface VisionSessionConfig {
  mode: VisionMode;
  timeMode: VisionTimeMode;
  /** Уровень сложности 1..3 (ADR-167 §2.1); пишется в итог сессии. */
  difficulty: number;
}

/** Режимы, выбираемые в лобби (1–5 + mixed). Режим 6 — отдельная задача. */
const LOBBY_MODES: readonly VisionMode[] = [
  'color',
  'find',
  'name',
  'relation',
  'geometry',
  'mixed',
];

const DIFFICULTIES: readonly number[] = [1, 2, 3];

const LS_KEY = 'vision:config:v1';

const DEFAULT_CONFIG: VisionSessionConfig = {
  mode: 'color',
  timeMode: '60s',
  difficulty: 1,
};

function loadConfig(): VisionSessionConfig {
  if (typeof window === 'undefined') return DEFAULT_CONFIG;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const p = JSON.parse(raw) as Partial<VisionSessionConfig>;
    const mode = LOBBY_MODES.includes(p.mode as VisionMode)
      ? (p.mode as VisionMode)
      : DEFAULT_CONFIG.mode;
    const timeMode = VISION_TIME_MODES.includes(p.timeMode as VisionTimeMode)
      ? (p.timeMode as VisionTimeMode)
      : DEFAULT_CONFIG.timeMode;
    const difficulty = DIFFICULTIES.includes(p.difficulty as number)
      ? (p.difficulty as number)
      : DEFAULT_CONFIG.difficulty;
    return { mode, timeMode, difficulty };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(cfg: VisionSessionConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  } catch {
    /* quota — игнорируем */
  }
}

export interface VisionLobbyProps {
  onStart: (config: VisionSessionConfig) => void;
}

export function VisionLobby({ onStart }: VisionLobbyProps) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<VisionSessionConfig>(() => loadConfig());

  useEffect(() => {
    saveConfig(config);
  }, [config]);

  const setMode = useCallback(
    (mode: VisionMode) => setConfig((c) => ({ ...c, mode })),
    [],
  );
  const setTimeMode = useCallback(
    (timeMode: VisionTimeMode) => setConfig((c) => ({ ...c, timeMode })),
    [],
  );
  const setDifficulty = useCallback(
    (difficulty: number) => setConfig((c) => ({ ...c, difficulty })),
    [],
  );

  const handleStart = useCallback(() => onStart(config), [config, onStart]);

  return (
    <div className="vision-lobby" data-testid="vision-lobby">
      {/* Режим */}
      <fieldset className="vision-lobby__group" data-testid="vision-lobby-mode">
        <legend className="vision-lobby__legend">
          {t('vision.lobby.mode', 'Mode')}
        </legend>
        <div className="vision-lobby__options">
          {LOBBY_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className="vision-lobby__option"
              data-testid={`vision-lobby-mode-${m}`}
              data-selected={config.mode === m ? 'true' : 'false'}
              aria-pressed={config.mode === m}
              onClick={() => setMode(m)}
            >
              {t(`vision.mode.${m}`, MODE_FALLBACK[m])}
            </button>
          ))}
        </div>
      </fieldset>

      {/* Длительность */}
      <fieldset className="vision-lobby__group" data-testid="vision-lobby-time">
        <legend className="vision-lobby__legend">
          {t('vision.lobby.time', 'Time')}
        </legend>
        <div className="vision-lobby__options">
          {VISION_TIME_MODES.map((tm) => (
            <button
              key={tm}
              type="button"
              className="vision-lobby__option"
              data-testid={`vision-lobby-time-${tm}`}
              data-selected={config.timeMode === tm ? 'true' : 'false'}
              aria-pressed={config.timeMode === tm}
              onClick={() => setTimeMode(tm)}
            >
              {tm}
            </button>
          ))}
        </div>
      </fieldset>

      {/* Сложность */}
      <fieldset
        className="vision-lobby__group"
        data-testid="vision-lobby-difficulty"
      >
        <legend className="vision-lobby__legend">
          {t('vision.lobby.difficulty', 'Difficulty')}
        </legend>
        <div className="vision-lobby__options">
          {DIFFICULTIES.map((d) => (
            <button
              key={d}
              type="button"
              className="vision-lobby__option"
              data-testid={`vision-lobby-difficulty-${d}`}
              data-selected={config.difficulty === d ? 'true' : 'false'}
              aria-pressed={config.difficulty === d}
              onClick={() => setDifficulty(d)}
            >
              {t(`vision.difficulty.${d}`, DIFFICULTY_FALLBACK[d])}
            </button>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        className="vision-lobby__start play-btn"
        data-testid="vision-lobby-start"
        onClick={handleStart}
      >
        {t('vision.lobby.start', 'Start')}
      </button>
    </div>
  );
}

const MODE_FALLBACK: Record<VisionMode, string> = {
  color: 'Square color',
  find: 'Find the square',
  name: 'Name the square',
  relation: 'Relation',
  geometry: 'Piece geometry',
  mixed: 'Mixed',
};

const DIFFICULTY_FALLBACK: Record<number, string> = {
  1: 'Easy',
  2: 'Medium',
  3: 'Hard',
};
