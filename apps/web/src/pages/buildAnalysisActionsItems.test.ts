/**
 * KS-3910 / ADR-117 C06. Тесты фильтрации пунктов меню действий
 * по политике инструментов лекции (`studentToolsPolicy`).
 *
 * Скрытие применяется ТОЛЬКО при `publicMode=true` (viewer-live
 * лекции). У владельца меню всегда полное.
 *
 * Маппинг:
 *   - запись `analyze_game`     → пункт `analyze-game` убран;
 *   - запись `generate_puzzle`  → пункт `generate-puzzle` убран;
 *   - запись `find_by_position` → пункт `find-by-position` убран.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  buildAnalysisActionsItems,
  type BuildItemsContext,
} from './AnalysisPage';
import type { LectureDisabledTool } from '@kingside/shared';

function ctx(overrides: Partial<BuildItemsContext> = {}): BuildItemsContext {
  return {
    t: (_k: string, def?: string) => def ?? _k,
    gameId: undefined,
    navigate: vi.fn(),
    currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    historyLen: 5,
    kind: 'analysis',
    publicMode: true,
    user: { id: 'student-1' },
    localIdRef: { current: null },
    savedOwnerId: null,
    creatingRepertoire: false,
    repertoires: null,
    repertoiresLoading: false,
    analysisTitle: 'Test',
    buildAnalysisPgn: () => '1. e4 e5',
    handleExportPgn: vi.fn(),
    handleCopyPgn: vi.fn(),
    setShowSetPosition: vi.fn(),
    setShowPgnHeaders: vi.fn(),
    liveViewer: false,
    setPuzzleGenPgn: vi.fn(),
    setShowPuzzleGen: vi.fn(),
    setSidePickerOpen: vi.fn(),
    setAddToRepertoireOpen: vi.fn(),
    shareButtonRef: { current: null },
    openArchiveRepertoireModal: vi.fn(),
    onRunGameReview: vi.fn(),
    gameReviewDisabled: false,
    gameReviewDisabledHint: undefined,
    onRunPositionReview: vi.fn(),
    onStopPositionReview: vi.fn(),
    positionReviewActive: false,
    liveAnalysisId: null,
    liveIsLive: false,
    liveIsStarting: false,
    livePublicUrl: null,
    onLiveCopyLink: vi.fn(),
    onLiveStop: vi.fn(),
    onStartLecture: vi.fn(),
    ...overrides,
  };
}

function ids(items: ReturnType<typeof buildAnalysisActionsItems>): string[] {
  return items.map((it) => it.id);
}

describe('buildAnalysisActionsItems — KS-3910 фильтрация по studentToolsPolicy', () => {
  it('publicMode=true + policy=["analyze_game"] → пункт analyze-game убран', () => {
    const items = buildAnalysisActionsItems(
      ctx({ studentToolsPolicy: ['analyze_game'] }),
    );
    expect(ids(items)).not.toContain('analyze-game');
    // Прочие пункты остаются.
    expect(ids(items)).toContain('find-by-position');
    expect(ids(items)).toContain('generate-puzzle');
  });

  it('publicMode=true + policy=["generate_puzzle"] → пункт generate-puzzle убран', () => {
    const items = buildAnalysisActionsItems(
      ctx({ studentToolsPolicy: ['generate_puzzle'] }),
    );
    expect(ids(items)).not.toContain('generate-puzzle');
    expect(ids(items)).toContain('analyze-game');
    expect(ids(items)).toContain('find-by-position');
  });

  it('publicMode=true + policy=["find_by_position"] → пункт find-by-position убран', () => {
    const items = buildAnalysisActionsItems(
      ctx({ studentToolsPolicy: ['find_by_position'] }),
    );
    expect(ids(items)).not.toContain('find-by-position');
    expect(ids(items)).toContain('analyze-game');
    expect(ids(items)).toContain('generate-puzzle');
  });

  it('publicMode=true + комбинированная политика → все три пункта убраны', () => {
    const items = buildAnalysisActionsItems(
      ctx({
        studentToolsPolicy: [
          'analyze_game',
          'generate_puzzle',
          'find_by_position',
        ],
      }),
    );
    const got = ids(items);
    expect(got).not.toContain('analyze-game');
    expect(got).not.toContain('generate-puzzle');
    expect(got).not.toContain('find-by-position');
  });

  it('publicMode=false (владелец) + полная политика → пункты НЕ скрываются', () => {
    const items = buildAnalysisActionsItems(
      ctx({
        publicMode: false,
        // KS-3910: владельцу политика учеников не применяется. Тренер
        // должен видеть весь набор инструментов независимо от того,
        // какие запреты он выставил ученикам.
        studentToolsPolicy: [
          'analyze_game',
          'generate_puzzle',
          'find_by_position',
        ],
      }),
    );
    const got = ids(items);
    expect(got).toContain('analyze-game');
    expect(got).toContain('generate-puzzle');
    expect(got).toContain('find-by-position');
  });

  it('publicMode=true + studentToolsPolicy=undefined → ничего не фильтруется', () => {
    const items = buildAnalysisActionsItems(ctx({ studentToolsPolicy: undefined }));
    const got = ids(items);
    expect(got).toContain('analyze-game');
    expect(got).toContain('generate-puzzle');
    expect(got).toContain('find-by-position');
  });

  it('publicMode=true + policy=[] → ничего не фильтруется', () => {
    const items = buildAnalysisActionsItems(ctx({ studentToolsPolicy: [] }));
    const got = ids(items);
    expect(got).toContain('analyze-game');
    expect(got).toContain('generate-puzzle');
    expect(got).toContain('find-by-position');
  });

  it('policy с записями engine/book/ai_comment не влияет на пункты меню (C06 покрывает только три тройки)', () => {
    const items = buildAnalysisActionsItems(
      ctx({
        studentToolsPolicy: ['engine', 'book', 'ai_comment'] as LectureDisabledTool[],
      }),
    );
    const got = ids(items);
    expect(got).toContain('analyze-game');
    expect(got).toContain('generate-puzzle');
    expect(got).toContain('find-by-position');
  });
});
