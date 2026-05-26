import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type {
  GeneratedPuzzleData,
  GenerationProgress,
  PuzzleGenSettings,
  BridgeConfig,
} from '../utils/puzzleGenerator';
import {
  generatePuzzlesFromPgn,
  DEFAULT_PUZZLE_GEN_SETTINGS,
  PUZZLE_GEN_NODES_MIN,
  PUZZLE_GEN_NODES_MAX,
  PUZZLE_GEN_NODES_STEP,
} from '../utils/puzzleGenerator';
import { loadEngineConfigs } from '../hooks/useEngine';

/**
 * KS-2585 / KS-3137 (ADR-068 §3.4) — UI генератора пазлов на shared
 * `evaluateBlunder`.
 *
 * История:
 *  - KS-2585: уход от CP-эпохи (removed multiPv/gap/maxSecondCp/
 *    acceptedMoves/skipHanging/skipAttacked/skipUndefended) и
 *    добавлен слайдер «Минимальная сила зевка» (`blunderDelta`);
 *  - KS-3137 (ADR-068 §3.4): один порог `blunderDelta` заменён на ДВА
 *    независимых слайдера ΔW/ΔD — алгоритм триггерит OR-ом, чтобы ловить
 *    как «упустил победу» (W упал), так и «упустил ничью» (D упал) без
 *    свёртки в один скаляр. Старое поле `blunderDelta` в localStorage
 *    игнорируется, дефолты `deltaWThreshold`/`deltaDThreshold` берутся
 *    из shared `PUZZLE_GEN_DEFAULTS` (60% + 60%).
 *
 * Защитные after-фильтры `minWAfterForSolver` / `minWPlusDAfterForSolver`
 * под UI не вынесены — это «не дать алгоритму записать в пазл позицию,
 * где решающий после зевка всё равно проигрывает». Юзер их не подбирает.
 *
 * `loadSettings` мигрирует localStorage: старые ключи (`multiPv`/
 * `gapThreshold`/`maxSecondCp`/`acceptedMoves`/`skip*`/`blunderDelta`)
 * игнорируются, берутся только новые поля с fallback'ом на
 * `DEFAULT_PUZZLE_GEN_SETTINGS`.
 */

const LS_KEY = 'puzzleGenSettings';

/**
 * Прочитать настройки из localStorage. Старые legacy-ключи (KS-2584 и
 * раньше) полностью игнорируем — берём только поля новой схемы и
 * мерджим с дефолтами. Это безопасная одноразовая миграция: даже если
 * у юзера в LS лежал JSON с `multiPv: 5, skipHanging: true`, новая
 * схема просто их не прочитает.
 */
function loadSettings(): PuzzleGenSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_PUZZLE_GEN_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<PuzzleGenSettings>;
    return {
      ...DEFAULT_PUZZLE_GEN_SETTINGS,
      // KS-3364: depth убран из UI, в localStorage больше не хранится
      // (легаси-ключ молча игнорируем). Управление через `nodes`.
      nodes:
        typeof parsed.nodes === 'number' && parsed.nodes > 0
          ? parsed.nodes
          : DEFAULT_PUZZLE_GEN_SETTINGS.nodes,
      deltaWThreshold:
        typeof parsed.deltaWThreshold === 'number'
          ? parsed.deltaWThreshold
          : DEFAULT_PUZZLE_GEN_SETTINGS.deltaWThreshold,
      deltaDThreshold:
        typeof parsed.deltaDThreshold === 'number'
          ? parsed.deltaDThreshold
          : DEFAULT_PUZZLE_GEN_SETTINGS.deltaDThreshold,
      // KS-3160 (ADR-070 F1): `solvabilityCheck` снят вместе с локальной
      // копией `solvabilityPasses`. В shared `processGameForPuzzles`
      // такого этапа нет — решаемость гарантирует after-фильтр
      // `evaluateBlunder` (W+D ≥ minWPlusDAfterForSolver). Старое
      // значение из localStorage молча игнорируется (одноразовая
      // миграция, как KS-3137 для blunderDelta).
    };
  } catch {
    return { ...DEFAULT_PUZZLE_GEN_SETTINGS };
  }
}

function saveSettings(s: PuzzleGenSettings) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

interface PuzzleGeneratorModalProps {
  onClose: () => void;
  /**
   * KS-2958: предзаполненный PGN (например, из окна анализа). Если задан —
   * блоки «upload .pgn» и `<textarea>` скрываются, юзер не вводит PGN
   * руками. PGN можно по-прежнему изменить параметрами (depth/blunderDelta)
   * через раздел «Advanced Settings».
   */
  initialPgn?: string;
  /**
   * KS-2958: автоматически запустить генерацию сразу после открытия
   * модала. Используется в сочетании с `initialPgn` — клик «Сгенерировать
   * пазл» из overflow-меню анализа сразу же показывает прогресс, без
   * лишнего «Generate» нажатия. Срабатывает один раз.
   */
  autoStart?: boolean;
}

export function PuzzleGeneratorModal({
  onClose,
  initialPgn,
  autoStart = false,
}: PuzzleGeneratorModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pgnText, setPgnText] = useState(initialPgn ?? '');
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [result, setResult] = useState<GeneratedPuzzleData[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ saved: number; total: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [settings, setSettings] = useState<PuzzleGenSettings>(loadSettings);
  const [engineType, setEngineType] = useState<'wasm' | 'bridge'>('wasm');
  const abortRef = useRef<AbortController | null>(null);

  const savedConfigs = loadEngineConfigs();
  const hasBridge = savedConfigs.length > 0;
  const bridgeConfig: BridgeConfig | undefined = engineType === 'bridge' && hasBridge
    ? { wsUrl: savedConfigs[0].wsUrl, secretKey: savedConfigs[0].secretKey }
    : undefined;

  const updateSetting = <K extends keyof PuzzleGenSettings>(
    key: K,
    value: PuzzleGenSettings[K],
  ) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      saveSettings(next);
      return next;
    });
  };

  const resetSettings = () => {
    setSettings({ ...DEFAULT_PUZZLE_GEN_SETTINGS });
    saveSettings({ ...DEFAULT_PUZZLE_GEN_SETTINGS });
  };

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setPgnText(ev.target?.result as string ?? '');
    reader.readAsText(file);
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!pgnText.trim() || generating) return;
    setGenerating(true);
    setError(null);
    setResult(null);
    setSaved(false);
    abortRef.current = new AbortController();
    try {
      const puzzles = await generatePuzzlesFromPgn(
        pgnText,
        (p) => setProgress(p),
        { ...settings, abortSignal: abortRef.current.signal, bridgeConfig },
      );
      setResult(puzzles);
    } catch (err) {
      console.error('[PuzzleGen] Generation error:', err);
      if (err instanceof Error && err.name !== 'AbortError') {
        setError(err.message);
      } else if (typeof err === 'string') {
        setError(err);
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }, [pgnText, generating, settings, bridgeConfig]);

  const handleSave = useCallback(async () => {
    if (!result || result.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    const BATCH_SIZE = 200;
    const total = result.length;
    let savedCount = 0;
    setSaveProgress({ saved: 0, total });
    try {
      for (let i = 0; i < total; i += BATCH_SIZE) {
        const batch = result.slice(i, i + BATCH_SIZE);
        await api.post('/puzzles/batch', { puzzles: batch });
        savedCount += batch.length;
        setSaveProgress({ saved: savedCount, total });
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
      setSaveProgress(null);
    }
  }, [result, saving]);

  const handlePublishAll = useCallback(async () => {
    if (publishing) return;
    setPublishing(true);
    setError(null);
    try {
      // KS-2585 (ADR-050 §2.3): batch-публикация всех черновиков
      // текущего пользователя. Backend в KS-2579-#1 принимает PATCH без
      // body и ставит `is_public=true` для всех `solutionMode='play-vs-engine'`
      // пазлов с `userId=current && is_public=false`.
      await api.patch('/puzzles/publish-all', {});
      onClose();
      navigate('/precision');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }, [publishing, onClose, navigate]);

  const handleViewMyDrafts = useCallback(() => {
    onClose();
    navigate('/precision?mine=true&visibility=draft');
  }, [onClose, navigate]);

  // KS-2958: автозапуск генерации при открытии с предзаполненным PGN
  // (точка входа из overflow-меню анализа). Срабатывает один раз: гард
  // через ref защищает от повторных вызовов при ре-рендере (StrictMode
  // dev double-invoke).
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart) return;
    if (autoStartedRef.current) return;
    if (!pgnText.trim()) return;
    if (generating || result) return;
    autoStartedRef.current = true;
    void handleGenerate();
  }, [autoStart, pgnText, generating, result, handleGenerate]);

  // KS-3137: оба слайдера в UI работают в %, в state — в долях [0..1].
  const deltaWPct = Math.round(settings.deltaWThreshold * 100);
  const deltaDPct = Math.round(settings.deltaDThreshold * 100);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content puzzle-generator-modal"
        onClick={(e) => e.stopPropagation()}
        data-testid="puzzle-generator-modal"
      >
        <div className="modal-header">
          <h2>{t('puzzleGenerator.title', 'Generate Puzzles from PGN')}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {!generating && !result && (
          <div className="puzzle-generator-input">
            {/* KS-2958: при `initialPgn` (запуск из окна анализа) скрываем
                блоки upload + textarea — PGN уже передан, юзеру не надо
                его вводить руками. Advanced settings (depth/blunderDelta)
                остаются доступны. */}
            {!initialPgn && (
              <>
                <div className="puzzle-generator-upload">
                  <input type="file" accept=".pgn" onChange={handleFileUpload} className="puzzle-generator-file" />
                  <span className="puzzle-generator-or">{t('common.or', 'or')}</span>
                </div>
                <textarea
                  className="puzzle-generator-textarea"
                  placeholder={t('puzzleGenerator.pastePgn', 'Paste PGN here...')}
                  value={pgnText}
                  onChange={(e) => setPgnText(e.target.value)}
                  rows={6}
                  data-testid="puzzle-generator-textarea"
                />
              </>
            )}

            {/* Advanced Settings */}
            <div className="puzzle-gen-advanced">
              <button
                className="puzzle-gen-advanced__toggle"
                onClick={() => setShowAdvanced(!showAdvanced)}
                data-testid="puzzle-generator-advanced-toggle"
              >
                {showAdvanced ? '▾' : '▸'} {t('puzzleGenerator.advancedSettings', 'Advanced Settings')}
              </button>
              {showAdvanced && (
                <div
                  className="puzzle-gen-advanced__body"
                  data-testid="puzzle-generator-advanced-body"
                >
                  {/* ENGINE */}
                  <h4 className="puzzle-gen-section-title">{t('puzzleGenerator.sectionEngine', 'ENGINE')}</h4>
                  <div className="puzzle-gen-engine-tabs">
                    <button
                      className={`puzzle-gen-engine-tab${engineType === 'wasm' ? ' active' : ''}`}
                      onClick={() => setEngineType('wasm')}
                    >
                      WASM
                    </button>
                    <button
                      className={`puzzle-gen-engine-tab${engineType === 'bridge' ? ' active' : ''}`}
                      onClick={() => setEngineType('bridge')}
                      disabled={!hasBridge}
                    >
                      Bridge
                    </button>
                  </div>
                  <p className="puzzle-gen-engine-hint">
                    {engineType === 'wasm'
                      ? t('puzzleGenerator.engineWasmHint', 'Browser Stockfish (1 thread, slower)')
                      : hasBridge
                        ? t('puzzleGenerator.engineBridgeHint', 'External engine via WebSocket (multi-threaded, faster)')
                        : t('puzzleGenerator.engineBridgeNotConfigured', 'Configure external engine in Analysis page first')}
                  </p>

                  {/* ANALYSIS */}
                  <h4 className="puzzle-gen-section-title">{t('puzzleGenerator.sectionAnalysis', 'ANALYSIS')}</h4>
                  <div className="puzzle-gen-params">
                    {/* KS-3364: «Глубина» заменена на «Узлы» — пользователю
                        понятнее, лимит соответствует серверной генерации
                        (AnalysisLimit.nodes). Показываем значение в миллионах
                        («10M»), внутрь шлём в полных единицах. */}
                    <div className="puzzle-gen-param">
                      <label>
                        {t('puzzleGenerator.nodes.label', 'Nodes')}:{' '}
                        {t('puzzleGenerator.nodes.value', '{{value}}M', {
                          value: Math.round(settings.nodes / 1_000_000),
                        })}
                      </label>
                      <input
                        type="range"
                        min={PUZZLE_GEN_NODES_MIN}
                        max={PUZZLE_GEN_NODES_MAX}
                        step={PUZZLE_GEN_NODES_STEP}
                        value={settings.nodes}
                        onChange={(e) =>
                          updateSetting('nodes', Number(e.target.value))
                        }
                        data-testid="puzzle-generator-nodes"
                      />
                      <p className="puzzle-gen-param-hint">
                        {t(
                          'puzzleGenerator.nodes.hint',
                          'Number of positions Stockfish examines per ply. Higher = more accurate, but slower. Default 10M ≈ depth 18 in browser.',
                        )}
                      </p>
                    </div>
                    {/* KS-3137 (ADR-068 §3.4): два независимых слайдера —
                        алгоритм триггерит «зевок» по OR (ΔW ≥ thrW ИЛИ
                        ΔD ≥ thrD), это нужно чтобы ловить и «упустил
                        победу», и «упустил ничью», не сводя их в один
                        скаляр. Дефолты 60% оба — из shared
                        `PUZZLE_GEN_DEFAULTS`. */}
                    <div className="puzzle-gen-param">
                      <label>
                        {t(
                          'puzzleGenerator.deltaW.label',
                          'Min win-probability drop (ΔW)',
                        )}
                        :{' '}
                        {t('puzzleGenerator.deltaW.value', '{{percent}}%', {
                          percent: deltaWPct,
                        })}
                      </label>
                      <input
                        type="range"
                        min={30}
                        max={90}
                        step={5}
                        value={deltaWPct}
                        onChange={(e) =>
                          updateSetting(
                            'deltaWThreshold',
                            Number(e.target.value) / 100,
                          )
                        }
                        data-testid="puzzle-generator-delta-w"
                      />
                      <p className="puzzle-gen-param-hint">
                        {t(
                          'puzzleGenerator.deltaW.hint',
                          'How much the win probability for the player to move has to fall in one move to count as a blunder. Higher = stricter; 60% matches the server pipeline.',
                        )}
                      </p>
                    </div>
                    <div className="puzzle-gen-param">
                      <label>
                        {t(
                          'puzzleGenerator.deltaD.label',
                          'Min draw-probability drop (ΔD)',
                        )}
                        :{' '}
                        {t('puzzleGenerator.deltaD.value', '{{percent}}%', {
                          percent: deltaDPct,
                        })}
                      </label>
                      <input
                        type="range"
                        min={30}
                        max={90}
                        step={5}
                        value={deltaDPct}
                        onChange={(e) =>
                          updateSetting(
                            'deltaDThreshold',
                            Number(e.target.value) / 100,
                          )
                        }
                        data-testid="puzzle-generator-delta-d"
                      />
                      <p className="puzzle-gen-param-hint">
                        {t(
                          'puzzleGenerator.deltaD.hint',
                          'How much the draw probability has to fall — catches "missed a draw" puzzles independently of ΔW. Default 60%.',
                        )}
                      </p>
                    </div>
                    {/* KS-3160 (ADR-070 F1): toggle «Strict solvability
                        check» снят. В shared `processGameForPuzzles`
                        такого этапа нет; решаемость гарантирует after-
                        фильтр evaluateBlunder. Старое поле LS
                        игнорируется при загрузке (см. loadSettings). */}
                  </div>

                  <button
                    className="puzzle-gen-settings-reset"
                    onClick={resetSettings}
                  >
                    {t('puzzleGenerator.resetDefaults', 'Reset to defaults')}
                  </button>
                </div>
              )}
            </div>

            <button
              className="puzzle-generator-start"
              onClick={handleGenerate}
              disabled={!pgnText.trim() || (engineType === 'bridge' && !hasBridge)}
              data-testid="puzzle-generator-start"
            >
              {t('puzzleGenerator.generate', 'Generate Puzzles')}
            </button>
          </div>
        )}

        {generating && progress && (
          <div className="puzzle-generator-progress">
            <div className="puzzle-generator-progress-text">{t('puzzleGenerator.analyzing', 'Analyzing...')}</div>
            <div className="puzzle-generator-progress-detail">
              {t('puzzleGenerator.progressDetail', 'Game {{game}}/{{totalGames}}, Position {{pos}}/{{totalPos}}', { game: progress.gameIndex + 1, totalGames: progress.totalGames, pos: progress.positionIndex + 1, totalPos: progress.totalPositions })}
            </div>
            <div className="puzzle-generator-progress-bar">
              <div className="puzzle-generator-progress-fill" style={{ width: `${progress.totalPositions > 0 ? ((progress.gameIndex * 100 + (progress.positionIndex / progress.totalPositions) * 100) / Math.max(progress.totalGames, 1)) : 0}%` }} />
            </div>
            <div className="puzzle-generator-progress-found">{t('puzzleGenerator.puzzlesFound', '{{count}} puzzles found', { count: progress.puzzlesFound })}</div>
            <button className="puzzle-generator-abort" onClick={() => abortRef.current?.abort()}>{t('common.cancel', 'Cancel')}</button>
          </div>
        )}

        {result && (
          <div className="puzzle-generator-result">
            <div className="puzzle-generator-result-count">
              {t('puzzleGenerator.resultCount', '{{count}} puzzles generated', { count: result.length })}
            </div>
            {result.length > 0 && (
              <>
                <div className="puzzle-generator-result-list">
                  {result.slice(0, 10).map((p, i) => (
                    <div key={i} className="puzzle-generator-result-item">
                      {/* KS-2692 (продолжение KS-2689): рейтинг
                          сгенерированных пазлов рассчитывается по
                          упрощённой формуле (ADR-044 §3.5) и в UX
                          путает пользователя. Скрываем span до тех
                          пор, пока формула не будет доработана.
                          Поле `p.rating` остаётся в payload save'а
                          (POST /puzzles/batch) — backend получает
                          рейтинг как и раньше.
                          KS-3143: span `gap: {p.gap}` снят — поле было
                          legacy от cp-алгоритма (ADR-050), в payload
                          его тоже больше не пишем. */}
                      <span className="puzzle-themes-inline">{p.themes}</span>
                    </div>
                  ))}
                  {result.length > 10 && (
                    <div className="puzzle-generator-result-more">
                      {t('puzzleGenerator.andNMore', '...and {{count}} more', { count: result.length - 10 })}
                    </div>
                  )}
                </div>
                {!saved ? (
                  <button
                    className="puzzle-generator-save"
                    onClick={handleSave}
                    disabled={saving}
                    data-testid="puzzle-generator-save"
                  >
                    {saving && saveProgress
                      ? `${t('puzzleGenerator.saving', 'Saving')} ${saveProgress.saved}/${saveProgress.total}...`
                      : saving
                        ? t('common.loading')
                        : t('puzzleGenerator.save', 'Save to Server')}
                  </button>
                ) : (
                  <div
                    className="puzzle-generator-saved"
                    data-testid="puzzle-generator-saved"
                  >
                    <h3 className="puzzle-generator-saved__title">
                      {t(
                        'puzzleGenerator.savedAsDrafts',
                        '{{count}} saved as drafts',
                        { count: result.length },
                      )}
                    </h3>
                    <p className="puzzle-generator-saved__hint">
                      {t(
                        'puzzleGenerator.draftsExplanation',
                        'Drafts are visible only to you. Publish them to make them appear in Precision Training for everyone.',
                      )}
                    </p>
                    <div className="puzzle-generator-saved__actions">
                      <button
                        type="button"
                        onClick={handleViewMyDrafts}
                        data-testid="puzzle-generator-my-drafts"
                      >
                        {t('puzzleGenerator.myDrafts', 'My drafts')}
                      </button>
                      <button
                        type="button"
                        className="puzzle-generator-saved__publish"
                        onClick={handlePublishAll}
                        disabled={publishing}
                        data-testid="puzzle-generator-publish-all"
                      >
                        {publishing
                          ? t('puzzleGenerator.publishing', 'Publishing…')
                          : t(
                              'puzzleGenerator.publishAll',
                              'Publish all to Precision Training',
                            )}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            <button
              className="puzzle-generator-retry"
              onClick={() => {
                setResult(null);
                setProgress(null);
                setSaved(false);
              }}
            >
              {t('puzzleGenerator.generateMore', 'Generate More')}
            </button>
          </div>
        )}

        {error && (
          <div
            className="puzzle-generator-error"
            data-testid="puzzle-generator-error"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
