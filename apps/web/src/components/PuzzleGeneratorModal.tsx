import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { GeneratedPuzzleData, GenerationProgress, PuzzleGenSettings, BridgeConfig } from '../utils/puzzleGenerator';
import { generatePuzzlesFromPgn, DEFAULT_PUZZLE_GEN_SETTINGS } from '../utils/puzzleGenerator';
import { loadEngineConfigs } from '../hooks/useEngine';

const LS_KEY = 'puzzleGenSettings';

function loadSettings(): PuzzleGenSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULT_PUZZLE_GEN_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_PUZZLE_GEN_SETTINGS };
}

function saveSettings(s: PuzzleGenSettings) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

interface PuzzleGeneratorModalProps {
  onClose: () => void;
}

export function PuzzleGeneratorModal({ onClose }: PuzzleGeneratorModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pgnText, setPgnText] = useState('');
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [result, setResult] = useState<GeneratedPuzzleData[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ saved: number; total: number } | null>(null);
  const [saved, setSaved] = useState(false);
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

  const updateSetting = <K extends keyof PuzzleGenSettings>(key: K, value: PuzzleGenSettings[K]) => {
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
      const puzzles = await generatePuzzlesFromPgn(pgnText, (p) => setProgress(p), { ...settings, abortSignal: abortRef.current.signal, bridgeConfig });
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
  }, [pgnText, generating, settings]);

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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content puzzle-generator-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('puzzleGenerator.title', 'Generate Puzzles from PGN')}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {!generating && !result && (
          <div className="puzzle-generator-input">
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
            />

            {/* Advanced Settings */}
            <div className="puzzle-gen-advanced">
              <button className="puzzle-gen-advanced__toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
                {showAdvanced ? '▾' : '▸'} {t('puzzleGenerator.advancedSettings', 'Advanced Settings')}
              </button>
              {showAdvanced && (
                <div className="puzzle-gen-advanced__body">
                  {/* ENGINE */}
                  <h4 className="puzzle-gen-section-title">{t('puzzleGenerator.sectionEngine', 'ENGINE')}</h4>
                  <div className="puzzle-gen-engine-tabs">
                    <button className={`puzzle-gen-engine-tab${engineType === 'wasm' ? ' active' : ''}`} onClick={() => setEngineType('wasm')}>
                      WASM
                    </button>
                    <button className={`puzzle-gen-engine-tab${engineType === 'bridge' ? ' active' : ''}`} onClick={() => setEngineType('bridge')} disabled={!hasBridge}>
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
                    <div className="puzzle-gen-param">
                      <label>{t('puzzleGenerator.depth', 'Depth')}: {settings.depth}</label>
                      <input type="range" min={8} max={22} value={settings.depth} onChange={(e) => updateSetting('depth', Number(e.target.value))} />
                    </div>
                    <div className="puzzle-gen-param">
                      <label>{t('puzzleGenerator.lines', 'Lines')}</label>
                      <input type="number" min={2} max={5} value={settings.multiPv} onChange={(e) => updateSetting('multiPv', Number(e.target.value))} />
                    </div>
                    <div className="puzzle-gen-param">
                      <label>{t('puzzleGenerator.minGap', 'Min gap (cp)')}</label>
                      <input type="number" min={10} value={settings.gapThreshold} onChange={(e) => updateSetting('gapThreshold', Number(e.target.value))} />
                    </div>
                    <div className="puzzle-gen-param">
                      <label>{t('puzzleGenerator.maxSecond', 'Max 2nd eval (cp)')}</label>
                      <input type="number" min={50} value={settings.maxSecondCp} onChange={(e) => updateSetting('maxSecondCp', Number(e.target.value))} />
                    </div>
                    <div className="puzzle-gen-param">
                      <label>{t('puzzleGenerator.acceptedMoves', 'Accepted moves')}</label>
                      <input type="number" min={1} max={3} value={settings.acceptedMoves} onChange={(e) => updateSetting('acceptedMoves', Number(e.target.value))} />
                    </div>
                  </div>
                  {settings.acceptedMoves > 1 && (
                    <p className="puzzle-gen-engine-hint">
                      {t('puzzleGenerator.acceptedMovesHint', 'MultiPV will be auto-increased to {{n}} for {{m}} accepted moves', { n: Math.max(settings.multiPv, settings.acceptedMoves + 1), m: settings.acceptedMoves })}
                    </p>
                  )}

                  {/* FILTERS */}
                  <h4 className="puzzle-gen-section-title">{t('puzzleGenerator.sectionFilters', 'FILTERS')}</h4>
                  <div className="puzzle-gen-filters">
                    <label className="puzzle-gen-filter">
                      <input type="checkbox" checked={settings.skipHangingCapture} onChange={(e) => updateSetting('skipHangingCapture', e.target.checked)} />
                      <span>{t('puzzleGenerator.skipHanging', 'Skip hanging captures')}</span>
                      <span className="puzzle-gen-filter-hint">{t('puzzleGenerator.skipHangingHint', 'Exclude obvious free pieces')}</span>
                    </label>
                    <label className="puzzle-gen-filter">
                      <input type="checkbox" checked={settings.skipAttackedByLesser} onChange={(e) => updateSetting('skipAttackedByLesser', e.target.checked)} />
                      <span>{t('puzzleGenerator.skipAttacked', 'Skip attacked by lesser')}</span>
                      <span className="puzzle-gen-filter-hint">{t('puzzleGenerator.skipAttackedHint', 'Exclude moves where piece lands on attacked square')}</span>
                    </label>
                    <label className="puzzle-gen-filter">
                      <input type="checkbox" checked={settings.skipUndefendedAfterMove} onChange={(e) => updateSetting('skipUndefendedAfterMove', e.target.checked)} />
                      <span>{t('puzzleGenerator.skipUndefended', 'Skip undefended after move')}</span>
                      <span className="puzzle-gen-filter-hint puzzle-gen-filter-hint--warning">{t('puzzleGenerator.skipUndefendedHint', 'May filter out valid puzzles — use with caution')}</span>
                    </label>
                  </div>

                  <button className="puzzle-gen-settings-reset" onClick={resetSettings}>{t('puzzleGenerator.resetDefaults', 'Reset to defaults')}</button>
                </div>
              )}
            </div>

            <button className="puzzle-generator-start" onClick={handleGenerate} disabled={!pgnText.trim() || (engineType === 'bridge' && !hasBridge)}>
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
            <div className="puzzle-generator-result-count">{result.length} puzzles generated</div>
            {result.length > 0 && (
              <>
                <div className="puzzle-generator-result-list">
                  {result.slice(0, 10).map((p, i) => (
                    <div key={i} className="puzzle-generator-result-item">
                      <span className="puzzle-rating">{p.rating}</span>
                      <span className="puzzle-gap">gap: {p.gap}cp</span>
                      <span className="puzzle-themes-inline">{p.themes}</span>
                    </div>
                  ))}
                  {result.length > 10 && <div className="puzzle-generator-result-more">...and {result.length - 10} more</div>}
                </div>
                {!saved ? (
                  <button className="puzzle-generator-save" onClick={handleSave} disabled={saving}>
                    {saving && saveProgress
                      ? `${t('puzzleGenerator.saving', 'Saving')} ${saveProgress.saved}/${saveProgress.total}...`
                      : saving
                        ? t('common.loading')
                        : t('puzzleGenerator.save', 'Save to Server')}
                  </button>
                ) : (
                  <div className="puzzle-generator-saved">
                    <span>{t('puzzleGenerator.saved', 'Saved!')}</span>
                    <div className="puzzle-generator-saved__actions">
                      <button onClick={() => { onClose(); navigate('/puzzles?mine=true&solve=first'); }}>{t('puzzleGenerator.solveNow', 'Solve now')}</button>
                      <button onClick={() => { onClose(); navigate('/puzzles?mine=true'); }}>{t('puzzleGenerator.myPuzzles', 'My puzzles')}</button>
                    </div>
                  </div>
                )}
              </>
            )}
            <button className="puzzle-generator-retry" onClick={() => { setResult(null); setProgress(null); }}>
              {t('puzzleGenerator.generateMore', 'Generate More')}
            </button>
          </div>
        )}

        {error && <div className="puzzle-generator-error">{error}</div>}
      </div>
    </div>
  );
}
