/**
 * KS-3226 / ADR-075 §7 B6 — eval-сценарии mixed-урока (system-prompt v3).
 *
 * Финальные evals для ADR-075 M2. Проверяем, что system-prompt v3
 * содержит инструкции по каждому новому типу шага (puzzle / diagram /
 * game / drill) и жёсткий запрет на выдумывание FEN/PGN/puzzleId.
 *
 * Эти проверки — статические assertion'ы на содержимое промта. Реальные
 * behavioural evals с Anthropic LLM в CI не запускаются (стоимость +
 * flakiness); они идут как ручная QA после деплоя.
 */

import { __TESTING__ } from './system-prompt';
import { MAX_TOOL_TURNS } from './assistant-tools';

const PROMPT = __TESTING__.LESSON_CREATION_WORKFLOW;

describe('KS-3226 system-prompt v3 — sanity', () => {
  it('limit шагов поднят до 15 (раньше 10)', () => {
    expect(PROMPT).toMatch(/≤\s*15|<=\s*15|15 steps per lesson/);
    expect(PROMPT).not.toMatch(/≤\s*10 steps per lesson|<=\s*10 steps per lesson|10 steps per lesson via the assistant/);
  });

  it('MAX_TOOL_TURNS поднят до 16 (раньше 8)', () => {
    expect(MAX_TOOL_TURNS).toBe(16);
  });
});

describe('KS-3226 eval mixed-1: puzzle-step через add_puzzle_step_filter', () => {
  it('prompt описывает add_puzzle_step_filter с PuzzleTheme + ratingMin/Max + limit', () => {
    expect(PROMPT).toMatch(/add_puzzle_step_filter/);
    expect(PROMPT).toMatch(/PuzzleTheme/);
    expect(PROMPT).toMatch(/ratingMin/);
    expect(PROMPT).toMatch(/limit 1-10/);
  });

  it('prompt описывает find_puzzles_preview как НЕ-пишущий tool', () => {
    expect(PROMPT).toMatch(/find_puzzles_preview/);
    expect(PROMPT).toMatch(/без записи в БД|preview/i);
  });
});

describe('KS-3226 eval mixed-2: diagrams через text-шаг + validate_fen', () => {
  it('prompt требует validate_fen перед добавлением диаграммы', () => {
    expect(PROMPT).toMatch(/validate_fen/);
    expect(PROMPT).toMatch(/СНАЧАЛА вызови.*validate_fen|first.*validate_fen/i);
  });

  it('prompt описывает text-step diagrams с лимитом ≤5', () => {
    expect(PROMPT).toMatch(/diagrams/);
    expect(PROMPT).toMatch(/≤\s*5|5 per step/);
  });
});

describe('KS-3226 eval mixed-3: game-шаги — две формы (из анализа / inline PGN)', () => {
  it('prompt описывает list_my_analyses → add_game_step_from_analysis', () => {
    expect(PROMPT).toMatch(/list_my_analyses/);
    expect(PROMPT).toMatch(/add_game_step_from_analysis/);
  });

  it('prompt описывает add_game_step_from_pgn с обязательным вводом пользователя', () => {
    expect(PROMPT).toMatch(/add_game_step_from_pgn/);
    expect(PROMPT).toMatch(/НЕ ВЫДУМЫВАЙ ПАРТИИ|введён пользователем|user-?provided/i);
  });

  it('prompt описывает meta-поля для PGN', () => {
    expect(PROMPT).toMatch(/white.*black.*result|result.*white.*black/);
  });
});

describe('KS-3226 eval mixed-4: tactical drill через add_tactical_drill_step', () => {
  it('prompt описывает add_tactical_drill_step с 7 типами', () => {
    expect(PROMPT).toMatch(/add_tactical_drill_step/);
    for (const t of [
      'find-hanging-piece',
      'find-loose-piece',
      'find-pin',
      'find-fork',
      'count-attackers',
      'find-all-checks',
      'find-undefended-attack',
    ]) {
      expect(PROMPT).toContain(t);
    }
  });

  it('prompt описывает bucket easy/medium/hard и count 1-5', () => {
    expect(PROMPT).toMatch(/easy.*medium.*hard|easy\/medium\/hard/);
    expect(PROMPT).toMatch(/count 1-5/);
  });
});

describe('KS-3226 eval mixed-5: жёсткий запрет на выдумывание FEN/PGN/puzzleId', () => {
  it('явно сказано "НЕ выдумывай FEN-строки"', () => {
    expect(PROMPT).toMatch(/НЕ выдумывай FEN/);
  });

  it('явно сказано "НЕ выдумывай PGN"', () => {
    expect(PROMPT).toMatch(/НЕ выдумывай PGN/);
  });

  it('явно сказано "НЕ выдумывай puzzleId"', () => {
    expect(PROMPT).toMatch(/НЕ выдумывай puzzleId/);
  });

  it('явно запрещено выдумывать ходы конкретных партий (но общие вопросы про шахматы — можно)', () => {
    expect(PROMPT).toMatch(/НЕ выдумывай ходы конкретных партий/);
    expect(PROMPT).toMatch(/Общие вопросы про шахматы.*можно|можно/i);
  });
});

describe('KS-3226 mapping: русские термины → PuzzleTheme', () => {
  it('prompt содержит mapping для мат-в-N', () => {
    expect(PROMPT).toContain('мат в 1/2/3');
    expect(PROMPT).toContain('mateIn1');
    expect(PROMPT).toContain('mateIn2');
    expect(PROMPT).toContain('mateIn3');
  });

  it.each([
    ['вилка', 'fork'],
    ['связка', 'pin'],
    ['вскрытое нападение', 'discoveredAttack'],
    ['двойной шах', 'doubleCheck'],
    ['жертва', 'sacrifice'],
    ['эндшпиль', 'endgame'],
    ['дебют', 'opening'],
    ['миттельшпиль', 'middlegame'],
  ])('prompt сопоставляет «%s» → %s', (ru, en) => {
    expect(PROMPT).toContain(ru);
    expect(PROMPT).toContain(en);
  });
});
