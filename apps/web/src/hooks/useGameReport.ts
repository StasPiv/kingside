import { useState, useCallback } from 'react';
import { api } from '../api';

export type MoveClassification = 'brilliant' | 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'book';

export interface MoveAnalysis {
  moveNumber: number;
  color: 'white' | 'black';
  san: string;
  uci: string;
  evalBefore: { type: 'cp' | 'mate'; value: number } | null;
  evalAfter: { type: 'cp' | 'mate'; value: number } | null;
  bestMove: string | null;
  cpLoss: number;
  classification: MoveClassification;
}

export interface GameReport {
  id: string;
  gameId: string;
  whiteAccuracy: number;
  blackAccuracy: number;
  moves: MoveAnalysis[];
  status: string;
}

export function useGameReport(gameId: string | undefined) {
  const [report, setReport] = useState<GameReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    if (!gameId) return;
    setLoading(true);
    try {
      const data = await api.get<GameReport | null>(`/api/games/${gameId}/report`);
      if (data) setReport(data);
    } catch {
      // No report yet — not an error
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  const analyze = useCallback(async () => {
    if (!gameId) return;
    setAnalyzing(true);
    setError(null);
    try {
      const data = await api.post<GameReport>(`/api/games/${gameId}/analyze`, {});
      setReport(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  }, [gameId]);

  return { report, loading, analyzing, error, fetchReport, analyze };
}
