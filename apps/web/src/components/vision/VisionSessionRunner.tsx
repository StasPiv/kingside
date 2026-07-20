/**
 * KS-4984 / ADR-167 §7 (задача 3/7). Стейт-машина игрового цикла
 * Vision-тренажёра (Sprint):
 *
 *   playing  — выдан челлендж (генераторы `@kingside/shared`), идёт
 *              общий обратный отсчёт; ждём ответ.
 *   feedback — короткая пауза после ответа: подсветка верно/неверно,
 *              звук; ввод заморожен. По таймеру → следующий челлендж
 *              или финал (если общее время вышло).
 *   finished — время истекло; экран итогов + `POST /vision/results`.
 *
 * Считаем серию (streak/maxStreak), точность и среднее время ответа.
 * Образец потока — blind-board `BlindBoardSessionRunner`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  checkAnswer,
  generateChallenge,
  type VisionChallenge,
  type VisionResult,
} from '@kingside/shared';

import { useSounds } from '../../hooks/useSounds';
import {
  VisionChallengePanel,
  type VisionAnswer,
  type VisionFeedback,
} from './VisionChallengePanel';
import { VisionFinalScreen } from './VisionFinalScreen';
import type { VisionSessionConfig } from './VisionLobby';
import { visionApi } from '../../api/visionApi';

/** Пауза показа фидбека между вопросами (мс). */
const FEEDBACK_MS = 450;

const TIME_SECONDS: Record<VisionSessionConfig['timeMode'], number> = {
  '30s': 30,
  '60s': 60,
  '120s': 120,
};

type Phase = 'playing' | 'feedback' | 'finished';

interface Stats {
  score: number;
  total: number;
  streak: number;
  maxStreak: number;
  sumMs: number;
}

const ZERO_STATS: Stats = {
  score: 0,
  total: 0,
  streak: 0,
  maxStreak: 0,
  sumMs: 0,
};

export interface VisionSessionRunnerProps {
  config: VisionSessionConfig;
  onExit: () => void;
  /** DI для тестов. */
  api?: typeof visionApi;
}

export function VisionSessionRunner({
  config,
  onExit,
  api = visionApi,
}: VisionSessionRunnerProps) {
  const { t } = useTranslation();
  const { playSound } = useSounds();

  const [phase, setPhase] = useState<Phase>('playing');
  const [challenge, setChallenge] = useState<VisionChallenge>(() =>
    generateChallenge(config.mode),
  );
  const [feedback, setFeedback] = useState<VisionFeedback | null>(null);
  const [stats, setStats] = useState<Stats>(ZERO_STATS);
  const [secondsLeft, setSecondsLeft] = useState<number>(
    TIME_SECONDS[config.timeMode],
  );

  // Актуальные значения для финализации из таймера/таймаута (без stale-closure).
  const statsRef = useRef<Stats>(ZERO_STATS);
  const phaseRef = useRef<Phase>('playing');
  const questionStartRef = useRef<number>(0);
  const deadlineRef = useRef<number>(0);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now();

  const setPhaseBoth = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const finish = useCallback(() => {
    if (phaseRef.current === 'finished') return;
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    setFeedback(null);
    setPhaseBoth('finished');
  }, [setPhaseBoth]);

  // ── Старт сессии: сброс + запуск общего таймера ─────────────────────
  useEffect(() => {
    statsRef.current = ZERO_STATS;
    phaseRef.current = 'playing';
    setStats(ZERO_STATS);
    setFeedback(null);
    setPhase('playing');
    setChallenge(generateChallenge(config.mode));
    const totalSec = TIME_SECONDS[config.timeMode];
    setSecondsLeft(totalSec);
    deadlineRef.current = now() + totalSec * 1000;
    questionStartRef.current = now();

    const tick = setInterval(() => {
      const remainMs = deadlineRef.current - now();
      const left = Math.max(0, Math.ceil(remainMs / 1000));
      setSecondsLeft(left);
      if (remainMs <= 0) {
        clearInterval(tick);
        finish();
      }
    }, 200);

    return () => {
      clearInterval(tick);
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.mode, config.timeMode]);

  // ── Обработка ответа ────────────────────────────────────────────────
  const handleAnswer = useCallback(
    (value: VisionAnswer) => {
      if (phaseRef.current !== 'playing') return;
      const correct = checkAnswer(challenge, value);
      const elapsed = Math.max(0, Math.round(now() - questionStartRef.current));

      const prev = statsRef.current;
      const streak = correct ? prev.streak + 1 : 0;
      const next: Stats = {
        score: prev.score + (correct ? 1 : 0),
        total: prev.total + 1,
        streak,
        maxStreak: Math.max(prev.maxStreak, streak),
        sumMs: prev.sumMs + elapsed,
      };
      statsRef.current = next;
      setStats(next);

      playSound(correct ? 'puzzle-correct' : 'puzzle-incorrect');
      setFeedback({ correct, given: value });
      setPhaseBoth('feedback');

      feedbackTimerRef.current = setTimeout(() => {
        feedbackTimerRef.current = null;
        // Время могло выйти за время паузы — тогда финал.
        if (deadlineRef.current - now() <= 0) {
          finish();
          return;
        }
        setFeedback(null);
        setChallenge(generateChallenge(config.mode));
        questionStartRef.current = now();
        setPhaseBoth('playing');
      }, FEEDBACK_MS);
    },
    [challenge, config.mode, playSound, setPhaseBoth, finish],
  );

  // ── Финал ───────────────────────────────────────────────────────────
  if (phase === 'finished') {
    const s = statsRef.current;
    const result: VisionResult = {
      mode: config.mode,
      timeMode: config.timeMode,
      difficulty: config.difficulty,
      score: s.score,
      total: s.total,
      accuracy: s.total > 0 ? s.score / s.total : 0,
      maxStreak: s.maxStreak,
      avgResponseMs: s.total > 0 ? Math.round(s.sumMs / s.total) : 0,
    };
    return (
      <div
        className="vision-session"
        data-testid="vision-session"
        data-status="finished"
      >
        <VisionFinalScreen result={result} onPlayAgain={onExit} api={api} />
      </div>
    );
  }

  return (
    <div
      className="vision-session"
      data-testid="vision-session"
      data-status={phase}
    >
      {/* HUD: время / счёт / серия */}
      <div className="vision-session__hud" data-testid="vision-hud">
        <span className="vision-session__hud-stat" data-testid="vision-hud-time">
          <span className="vision-session__hud-label">
            {t('vision.hud.time', 'Time')}
          </span>
          <span className="vision-session__hud-value">{secondsLeft}s</span>
        </span>
        <span
          className="vision-session__hud-stat"
          data-testid="vision-hud-score"
        >
          <span className="vision-session__hud-label">
            {t('vision.hud.score', 'Score')}
          </span>
          <span className="vision-session__hud-value">{stats.score}</span>
        </span>
        <span
          className="vision-session__hud-stat"
          data-testid="vision-hud-streak"
        >
          <span className="vision-session__hud-label">
            {t('vision.hud.streak', 'Streak')}
          </span>
          <span className="vision-session__hud-value">{stats.streak}</span>
        </span>
        <span
          className="vision-session__hud-stat"
          data-testid="vision-hud-best"
        >
          <span className="vision-session__hud-label">
            {t('vision.hud.best', 'Best')}
          </span>
          <span className="vision-session__hud-value">{stats.maxStreak}</span>
        </span>
      </div>

      <VisionChallengePanel
        challenge={challenge}
        disabled={phase !== 'playing'}
        feedback={feedback}
        onAnswer={handleAnswer}
      />

      <button
        type="button"
        className="vision-session__quit"
        data-testid="vision-session-quit"
        onClick={finish}
      >
        {t('vision.session.finish', 'Finish')}
      </button>
    </div>
  );
}
