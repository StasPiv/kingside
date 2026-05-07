import { useState } from 'react';
import type { AnswerData, TacticDrillDto, TacticDrillType } from '@kingside/shared';

import { DrillBoard } from '../components/drills/DrillBoard';
import { DrillExplanationPanel } from '../components/drills/DrillExplanationPanel';
import { explainDrill } from '../components/drills/explanation/explainDrill';
import type { DrillBoardArrow } from '../components/drills/DrillBoard';
import type { ArrowRole } from '../components/drills/explanation/types';

/**
 * KS-2457 dev-страница: ручная верификация explanation-движка по 7
 * drill-типам. Каждый сценарий показывает пару (правильный ответ /
 * типичный неверный) с одной и той же позиции — чтобы быстро увидеть
 * стрелки/highlights/notes для каждого режима.
 *
 * Не requires auth (под dev_bypass), не требует backend — explanation
 * вычисляется локально через `explainDrill()`. Полезно для сверки
 * методики (KS-2454) при ревью UI и при отладке цветовых токенов
 * (KS-2458 layout).
 */

interface Scenario {
  key: string;
  label: string;
  drillType: TacticDrillType;
  fen: string;
  meta?: TacticDrillDto['meta'];
  correctAnswer: AnswerData;
  /** null = пользователь решил верно (показываем тот же correctAnswer). */
  userAnswer: AnswerData | null;
  solved: boolean;
}

// Все FEN'ы и фикстуры — из тестов byType/*.test.ts (KS-2456),
// проверены через chess.js на корректность.
const SCENARIOS: Scenario[] = [
  // count-attackers
  {
    key: 'count-attackers-correct',
    label: 'count-attackers · правильный (2 атакующих, ответил 2)',
    drillType: 'count-attackers',
    fen: '4k3/8/8/4p3/3P1P2/8/8/4K3 w - - 0 1',
    meta: { highlightedSquare: 'e5', attackerColor: 'w' },
    correctAnswer: { shape: 'number', value: 2 },
    userAnswer: { shape: 'number', value: 2 },
    solved: true,
  },
  {
    key: 'count-attackers-wrong',
    label: 'count-attackers · ошибся (ответил 1, правильно 2)',
    drillType: 'count-attackers',
    fen: '4k3/8/8/4p3/3P1P2/8/8/4K3 w - - 0 1',
    meta: { highlightedSquare: 'e5', attackerColor: 'w' },
    correctAnswer: { shape: 'number', value: 2 },
    userAnswer: { shape: 'number', value: 1 },
    solved: false,
  },
  {
    key: 'count-defenders',
    label: 'count-attackers · defenders mode (своя на target)',
    drillType: 'count-attackers',
    fen: '4k3/8/4r3/4p3/8/8/8/4K3 w - - 0 1',
    meta: { highlightedSquare: 'e5', attackerColor: 'b' },
    correctAnswer: { shape: 'number', value: 1 },
    userAnswer: { shape: 'number', value: 1 },
    solved: true,
  },

  // find-loose-piece
  {
    key: 'find-loose-piece-correct',
    label: 'find-loose-piece · правильный (a5 без защиты)',
    drillType: 'find-loose-piece',
    fen: '4k3/8/p7/r7/8/8/8/4K3 w - - 0 1',
    correctAnswer: { shape: 'square', square: 'a5' },
    userAnswer: { shape: 'square', square: 'a5' },
    solved: true,
  },
  {
    key: 'find-loose-piece-wrong',
    label: 'find-loose-piece · ошибся (a6 защищена ладьёй a5)',
    drillType: 'find-loose-piece',
    fen: '4k3/8/p7/r7/8/8/8/4K3 w - - 0 1',
    correctAnswer: { shape: 'square', square: 'a5' },
    userAnswer: { shape: 'square', square: 'a6' },
    solved: false,
  },

  // find-hanging-piece
  {
    key: 'find-hanging-piece-correct',
    label: 'find-hanging-piece · правильный (d4xe5)',
    drillType: 'find-hanging-piece',
    fen: '4k3/8/8/4r3/3P4/8/8/4K3 w - - 0 1',
    correctAnswer: { shape: 'move', from: 'd4', to: 'e5' },
    userAnswer: { shape: 'move', from: 'd4', to: 'e5' },
    solved: true,
  },
  {
    key: 'find-hanging-piece-wrong',
    label: 'find-hanging-piece · ошибся (d4-d5)',
    drillType: 'find-hanging-piece',
    fen: '4k3/8/8/4r3/3P4/8/8/4K3 w - - 0 1',
    correctAnswer: { shape: 'move', from: 'd4', to: 'e5' },
    userAnswer: { shape: 'move', from: 'd4', to: 'd5' },
    solved: false,
  },

  // find-all-checks
  {
    key: 'find-all-checks-correct',
    label: 'find-all-checks · 1 direct check (Ra1-a8+)',
    drillType: 'find-all-checks',
    fen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1',
    meta: { expectedMoves: [{ from: 'a1', to: 'a8' }] },
    correctAnswer: { shape: 'squares', squares: ['a8'] },
    userAnswer: { shape: 'squares', squares: ['a8'] },
    solved: true,
  },
  {
    key: 'find-all-checks-double',
    label: 'find-all-checks · double check (Ne6-c7+)',
    drillType: 'find-all-checks',
    fen: '4k3/8/4N3/4R3/8/8/8/4K3 w - - 0 1',
    meta: { expectedMoves: [{ from: 'e6', to: 'c7' }] },
    correctAnswer: { shape: 'squares', squares: ['c7'] },
    userAnswer: { shape: 'squares', squares: ['c7'] },
    solved: true,
  },
  {
    key: 'find-all-checks-missed',
    label: 'find-all-checks · пропустил шах',
    drillType: 'find-all-checks',
    fen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1',
    meta: { expectedMoves: [{ from: 'a1', to: 'a8' }] },
    correctAnswer: { shape: 'squares', squares: ['a8'] },
    userAnswer: { shape: 'squares', squares: [] },
    solved: false,
  },

  // find-pin
  {
    key: 'find-pin-absolute',
    label: 'find-pin · absolute (Re7 связана с королём e8)',
    drillType: 'find-pin',
    fen: '4k3/4r3/8/8/4Q3/8/8/4K3 w - - 0 1',
    correctAnswer: { shape: 'square', square: 'e7' },
    userAnswer: { shape: 'square', square: 'e7' },
    solved: true,
  },
  {
    key: 'find-pin-relative',
    label: 'find-pin · relative (Be3 связан с Qe4)',
    drillType: 'find-pin',
    fen: '4k3/8/8/8/4q3/4b3/4R3/4K3 w - - 0 1',
    correctAnswer: { shape: 'square', square: 'e3' },
    userAnswer: { shape: 'square', square: 'e3' },
    solved: true,
  },
  {
    key: 'find-pin-wrong',
    label: 'find-pin · ошибся (выбрал anchor, не pinned)',
    drillType: 'find-pin',
    fen: '4k3/4r3/8/8/4Q3/8/8/4K3 w - - 0 1',
    correctAnswer: { shape: 'square', square: 'e7' },
    userAnswer: { shape: 'square', square: 'e8' },
    solved: false,
  },

  // find-fork
  {
    key: 'find-fork-with-check',
    label: 'find-fork · royal fork (Nd5-c7+ ↦ Ra8 + Ke8)',
    drillType: 'find-fork',
    fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1',
    correctAnswer: { shape: 'move', from: 'd5', to: 'c7' },
    userAnswer: { shape: 'move', from: 'd5', to: 'c7' },
    solved: true,
  },
  {
    key: 'find-fork-wrong',
    label: 'find-fork · ошибся (Nd5-b6)',
    drillType: 'find-fork',
    fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1',
    correctAnswer: { shape: 'move', from: 'd5', to: 'c7' },
    userAnswer: { shape: 'move', from: 'd5', to: 'b6' },
    solved: false,
  },

  // find-undefended-attack
  {
    key: 'find-undefended-attack-correct',
    label: 'find-undefended-attack · Bc1-b2 атакует Ne5',
    drillType: 'find-undefended-attack',
    fen: '4k3/8/8/4n3/8/8/8/2B1K3 w - - 0 1',
    correctAnswer: { shape: 'move', from: 'c1', to: 'b2' },
    userAnswer: { shape: 'move', from: 'c1', to: 'b2' },
    solved: true,
  },
  {
    key: 'find-undefended-attack-wrong',
    label: 'find-undefended-attack · ошибся (Bc1-a3)',
    drillType: 'find-undefended-attack',
    fen: '4k3/8/8/4n3/8/8/8/2B1K3 w - - 0 1',
    correctAnswer: { shape: 'move', from: 'c1', to: 'b2' },
    userAnswer: { shape: 'move', from: 'c1', to: 'a3' },
    solved: false,
  },
];

function arrowRoleColor(role: ArrowRole): string {
  switch (role) {
    case 'correct-attack':
    case 'correct-move':
      return '#16a34a';
    case 'missed-attack':
      return '#94a3b8';
    case 'wrong-attack':
      return '#dc2626';
    case 'pin-line':
      return '#f97316';
    case 'defense':
      return '#3b82f6';
    case 'threat-target':
      return '#dc2626';
  }
}

export function DevDrillExplanationPage() {
  const [current, setCurrent] = useState<Scenario>(SCENARIOS[0]);

  const drill: TacticDrillDto = {
    id: `dev-${current.key}`,
    drillType: current.drillType,
    fen: current.fen,
    sideToMove: 'w',
    answerShape: current.correctAnswer.shape,
    difficulty: 1,
    ...(current.meta ? { meta: current.meta } : {}),
  };

  const explanation = explainDrill({
    drill,
    correctAnswer: current.correctAnswer,
    userAnswer: current.userAnswer,
    solved: current.solved,
  });

  const arrows: DrillBoardArrow[] = explanation.arrows.map((a) => ({
    startSquare: a.from,
    endSquare: a.to,
    color: arrowRoleColor(a.role),
  }));

  return (
    <div className="dev-drill-explanation-page" style={{ padding: 24, maxWidth: 1100 }}>
      <h1 style={{ marginTop: 0 }}>DrillExplanation — dev sandbox</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        KS-2457. Пары «правильный/неверный» по 7 drill-типам. Цвета
        стрелок и подсветок — placeholder, KS-2458 layout их
        финализирует. Тексты notes пока показывают i18n-ключи (KS-2459).
      </p>

      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            data-testid={`dev-drill-explanation-scenario-${s.key}`}
            onClick={() => setCurrent(s)}
            disabled={current.key === s.key}
            style={{ padding: '6px 10px', fontSize: 12 }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="drill-runner__board-and-panel">
        <DrillBoard
          position={current.fen}
          roleHighlights={explanation.highlights}
          arrows={arrows}
        />
        <DrillExplanationPanel
          explanation={explanation}
          solved={current.solved}
          onNext={() => {
            // На dev-странице «Дальше» переключает на следующий сценарий.
            const idx = SCENARIOS.findIndex((s) => s.key === current.key);
            const next = SCENARIOS[(idx + 1) % SCENARIOS.length];
            setCurrent(next);
          }}
        />
      </div>
    </div>
  );
}
