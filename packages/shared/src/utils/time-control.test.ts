import { describe, it, expect } from 'vitest';
import {
  classifyTimeControl,
  classifyPgnTimeControl,
  ARCHIVE_TIME_CONTROL_EVENT_HINTS,
} from './time-control.js';

describe('classifyTimeControl', () => {
  it('should classify bullet: totalTime < 180', () => {
    expect(classifyTimeControl(60, 0)).toBe('bullet');
    expect(classifyTimeControl(60, 1)).toBe('bullet');
    expect(classifyTimeControl(120, 0)).toBe('bullet');
  });

  it('should classify blitz: 180 <= totalTime < 600', () => {
    expect(classifyTimeControl(180, 0)).toBe('blitz');
    expect(classifyTimeControl(300, 0)).toBe('blitz');
    expect(classifyTimeControl(300, 3)).toBe('blitz');
  });

  it('should classify rapid: 600 <= totalTime < 3600', () => {
    expect(classifyTimeControl(600, 0)).toBe('rapid');
    expect(classifyTimeControl(900, 0)).toBe('rapid');
    expect(classifyTimeControl(1800, 0)).toBe('rapid');
  });

  it('should classify classical: totalTime >= 3600', () => {
    expect(classifyTimeControl(3600, 0)).toBe('classical');
    expect(classifyTimeControl(1800, 45)).toBe('classical');
  });

  it('should account for increment in classification', () => {
    expect(classifyTimeControl(60, 3)).toBe('blitz');
    expect(classifyTimeControl(120, 12)).toBe('rapid');
  });
});

describe('classifyPgnTimeControl', () => {
  it('returns unknown for null/empty/dash/question forms', () => {
    expect(classifyPgnTimeControl(null)).toBe('unknown');
    expect(classifyPgnTimeControl(undefined)).toBe('unknown');
    expect(classifyPgnTimeControl('')).toBe('unknown');
    expect(classifyPgnTimeControl('   ')).toBe('unknown');
    expect(classifyPgnTimeControl('-')).toBe('unknown');
    expect(classifyPgnTimeControl('?')).toBe('unknown');
  });

  it('classifies sudden-death without increment', () => {
    expect(classifyPgnTimeControl('60')).toBe('bullet');
    expect(classifyPgnTimeControl('120')).toBe('bullet');
    expect(classifyPgnTimeControl('180')).toBe('blitz');
    expect(classifyPgnTimeControl('300')).toBe('blitz');
    expect(classifyPgnTimeControl('600')).toBe('rapid');
    expect(classifyPgnTimeControl('1800')).toBe('rapid');
    expect(classifyPgnTimeControl('3600')).toBe('classical');
    expect(classifyPgnTimeControl('5400')).toBe('classical');
  });

  it('classifies sudden-death with increment (formula base + 40*inc)', () => {
    expect(classifyPgnTimeControl('60+0')).toBe('bullet');
    expect(classifyPgnTimeControl('60+1')).toBe('bullet'); // 60 + 40 = 100 < 180
    expect(classifyPgnTimeControl('60+3')).toBe('blitz');  // 60 + 120 = 180
    expect(classifyPgnTimeControl('300+3')).toBe('blitz'); // 300 + 120 = 420
    expect(classifyPgnTimeControl('900+10')).toBe('rapid');
    expect(classifyPgnTimeControl('5400+30')).toBe('classical');
    expect(classifyPgnTimeControl('1800+45')).toBe('classical'); // 1800 + 1800 = 3600
  });

  it('classifies single-stage `N/X` as base only', () => {
    // 40 ходов / 7200 секунд → берём X=7200, инкремент 0 → classical.
    expect(classifyPgnTimeControl('40/7200')).toBe('classical');
    expect(classifyPgnTimeControl('40/3600')).toBe('classical');
    expect(classifyPgnTimeControl('40/600')).toBe('rapid');
  });

  it('classifies single-stage `N/X+Y` by base + increment', () => {
    expect(classifyPgnTimeControl('40/7200+30')).toBe('classical');
    expect(classifyPgnTimeControl('40/600+5')).toBe('rapid');
  });

  it('uses ONLY the first phase for compound controls (ChessBase rule)', () => {
    // Первая фаза `40/7200+30` → classical (даже если хвост короче).
    expect(classifyPgnTimeControl('40/7200:1800+30')).toBe('classical');
    expect(classifyPgnTimeControl('40/7200+30:1800+30')).toBe('classical');
    expect(classifyPgnTimeControl('40/600+0:300+3')).toBe('rapid');
  });

  it('returns unknown for correspondence (`1/86400` and longer per-move)', () => {
    expect(classifyPgnTimeControl('1/86400')).toBe('unknown');
    expect(classifyPgnTimeControl('1/604800')).toBe('unknown');
  });

  it('returns unknown for unrecognised forms', () => {
    expect(classifyPgnTimeControl('hello')).toBe('unknown');
    expect(classifyPgnTimeControl('5400+30+10')).toBe('unknown');
    expect(classifyPgnTimeControl('abc/def')).toBe('unknown');
  });
});

describe('ARCHIVE_TIME_CONTROL_EVENT_HINTS (KS-2131)', () => {
  it('экспортирует hint-списки для миграции backfill и runtime-классификатора', () => {
    // KS-2131-fix: подстрока `titled tue` (а не `titled tuesday`) — TWIC
    // хранит сокращённую форму `Titled Tue 17th Jun Early`. Substring
    // покрывает и полную форму `Titled Tuesday`.
    expect(ARCHIVE_TIME_CONTROL_EVENT_HINTS.blitz).toContain('titled tue');
    expect(ARCHIVE_TIME_CONTROL_EVENT_HINTS.bullet).toContain('bullet brawl');
    expect(ARCHIVE_TIME_CONTROL_EVENT_HINTS.bullet).not.toContain('titled tue');
  });

  it('bullet-hints не пересекаются с blitz-hints (кроме generic-keyword порядка)', () => {
    // Generic-keyword `bullet` стоит в bullet-list последним, generic-keyword
    // `blitz` — в blitz-list последним. Пересечений между списками не должно
    // быть, иначе порядок проверки в потребителе становится критичным.
    const bulletSet = new Set<string>(ARCHIVE_TIME_CONTROL_EVENT_HINTS.bullet);
    for (const blitz of ARCHIVE_TIME_CONTROL_EVENT_HINTS.blitz) {
      expect(bulletSet.has(blitz)).toBe(false);
    }
  });

  it('подстрока `titled tue` матчит и полную, и сокращённую форму TWIC', () => {
    // sanity: реальные значения event'ов из прода (devops отчёт KS-2131).
    const samples = [
      'Titled Tuesday Blitz 21st Apr 2026',
      'Titled Tue 17th Jun Early',
      'Titled Tue 23rd Sep 2025',
      'Titled Tue 17th Jun Late',
    ];
    for (const event of samples) {
      const lower = event.toLowerCase();
      const matched = ARCHIVE_TIME_CONTROL_EVENT_HINTS.blitz.some((h) =>
        lower.includes(h),
      );
      expect(matched).toBe(true);
    }
  });
});
