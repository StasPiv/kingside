import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { GeneratedPuzzleData, GenerationProgress } from '../utils/puzzleGenerator';
import { generatePuzzlesFromPgn } from '../utils/puzzleGenerator';

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
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPgnText(ev.target?.result as string ?? '');
    };
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
        { depth: 14, multiPv: 3, gapThreshold: 150, abortSignal: abortRef.current.signal },
      );
      setResult(puzzles);
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setError(err.message);
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }, [pgnText, generating]);

  const handleAbort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleSave = useCallback(async () => {
    if (!result || result.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.post('/api/puzzles/generated/batch', { puzzles: result });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
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
              <input
                type="file"
                accept=".pgn"
                onChange={handleFileUpload}
                className="puzzle-generator-file"
              />
              <span className="puzzle-generator-or">{t('common.or', 'or')}</span>
            </div>
            <textarea
              className="puzzle-generator-textarea"
              placeholder={t('puzzleGenerator.pastePgn', 'Paste PGN here...')}
              value={pgnText}
              onChange={(e) => setPgnText(e.target.value)}
              rows={8}
            />
            <button
              className="puzzle-generator-start"
              onClick={handleGenerate}
              disabled={!pgnText.trim()}
            >
              {t('puzzleGenerator.generate', 'Generate Puzzles')}
            </button>
          </div>
        )}

        {generating && progress && (
          <div className="puzzle-generator-progress">
            <div className="puzzle-generator-progress-text">
              {t('puzzleGenerator.analyzing', 'Analyzing...')}
            </div>
            <div className="puzzle-generator-progress-detail">
              {t('puzzleGenerator.gameProgress', {
                game: progress.gameIndex + 1,
                totalGames: progress.totalGames,
                position: progress.positionIndex + 1,
                totalPositions: progress.totalPositions,
              }) || `Game ${progress.gameIndex + 1}/${progress.totalGames}, Position ${progress.positionIndex + 1}/${progress.totalPositions}`}
            </div>
            <div className="puzzle-generator-progress-bar">
              <div
                className="puzzle-generator-progress-fill"
                style={{
                  width: `${progress.totalPositions > 0
                    ? ((progress.gameIndex * 100 + (progress.positionIndex / progress.totalPositions) * 100) / Math.max(progress.totalGames, 1))
                    : 0}%`,
                }}
              />
            </div>
            <div className="puzzle-generator-progress-found">
              {t('puzzleGenerator.found', { count: progress.puzzlesFound }) || `${progress.puzzlesFound} puzzles found`}
            </div>
            <button className="puzzle-generator-abort" onClick={handleAbort}>
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        )}

        {result && (
          <div className="puzzle-generator-result">
            <div className="puzzle-generator-result-count">
              {t('puzzleGenerator.resultCount', { count: result.length }) || `${result.length} puzzles generated`}
            </div>
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
                  {result.length > 10 && (
                    <div className="puzzle-generator-result-more">
                      ...{t('puzzleGenerator.andMore', { count: result.length - 10 })}
                    </div>
                  )}
                </div>
                {!saved ? (
                  <button className="puzzle-generator-save" onClick={handleSave} disabled={saving}>
                    {saving ? t('common.loading') : t('puzzleGenerator.save', 'Save to Server')}
                  </button>
                ) : (
                  <div className="puzzle-generator-saved">
                    <span>{t('puzzleGenerator.saved', 'Saved!')}</span>
                    <button onClick={() => { onClose(); navigate('/puzzles'); }}>
                      {t('puzzleGenerator.goToTraining', 'Go to Training')}
                    </button>
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
