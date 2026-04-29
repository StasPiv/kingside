import {
  classifyGame,
  classifyTimeControl,
  deriveArchiveTimeControlCategory,
  parseTimeControl,
} from './classify';

describe('parseTimeControl', () => {
  it('парсит sudden death с инкрементом: 5400+30', () => {
    expect(parseTimeControl('5400+30')).toEqual({
      baseSeconds: 5400,
      incrementSeconds: 30,
      isCorrespondence: false,
      raw: '5400+30',
    });
  });

  it('парсит bullet: 60+0', () => {
    expect(parseTimeControl('60+0')).toEqual({
      baseSeconds: 60,
      incrementSeconds: 0,
      isCorrespondence: false,
      raw: '60+0',
    });
  });

  it('парсит multi-stage: 40/7200:3600 → суммирует базы', () => {
    expect(parseTimeControl('40/7200:3600')).toEqual({
      baseSeconds: 7200 + 3600,
      incrementSeconds: 0,
      isCorrespondence: false,
      raw: '40/7200:3600',
    });
  });

  it('парсит stage + inc в обеих фазах: 40/7200+30:3600+30', () => {
    expect(parseTimeControl('40/7200+30:3600+30')).toEqual({
      baseSeconds: 7200 + 3600,
      incrementSeconds: 30,
      isCorrespondence: false,
      raw: '40/7200+30:3600+30',
    });
  });

  it('распознаёт correspondence: 1/86400', () => {
    const p = parseTimeControl('1/86400');
    expect(p).not.toBeNull();
    expect(p!.isCorrespondence).toBe(true);
  });

  it('возвращает null для "-", "", null, undefined, "?"', () => {
    expect(parseTimeControl('-')).toBeNull();
    expect(parseTimeControl('')).toBeNull();
    expect(parseTimeControl(null)).toBeNull();
    expect(parseTimeControl(undefined)).toBeNull();
    expect(parseTimeControl('?')).toBeNull();
  });

  it('возвращает null для совсем мусорных значений', () => {
    expect(parseTimeControl('abc')).toBeNull();
    expect(parseTimeControl('5400+30+extra')).toBeNull();
  });
});

describe('classifyTimeControl', () => {
  it('5400+30 (90min + 30sec) → classical', () => {
    const r = classifyTimeControl('5400+30');
    expect(r.category).toBe('classical');
    expect(r.isClassical).toBe(true);
  });

  it('60+0 (1 min) → bullet', () => {
    const r = classifyTimeControl('60+0');
    expect(r.category).toBe('bullet');
    expect(r.isClassical).toBe(false);
  });

  it('25+10 (effective 25 + 600 = 625) → rapid', () => {
    const r = classifyTimeControl('25+10');
    expect(r.category).toBe('rapid');
    expect(r.isClassical).toBe(false);
  });

  it('180+1 (effective 180 + 60 = 240) → blitz', () => {
    const r = classifyTimeControl('180+1');
    expect(r.category).toBe('blitz');
    expect(r.isClassical).toBe(false);
  });

  it('40/7200:3600 (sum 10800) → classical', () => {
    const r = classifyTimeControl('40/7200:3600');
    expect(r.category).toBe('classical');
    expect(r.isClassical).toBe(true);
  });

  it('1/86400 → correspondence (не classical)', () => {
    const r = classifyTimeControl('1/86400');
    expect(r.category).toBe('correspondence');
    expect(r.isClassical).toBe(false);
  });

  it('"-" и null → unknown', () => {
    expect(classifyTimeControl('-').category).toBe('unknown');
    expect(classifyTimeControl(null).category).toBe('unknown');
    expect(classifyTimeControl(undefined).category).toBe('unknown');
  });

  it('edge case: ровно 3600s — classical', () => {
    const r = classifyTimeControl('3600+0');
    expect(r.category).toBe('classical');
    expect(r.isClassical).toBe(true);
  });

  it('edge case: 3599s — rapid', () => {
    const r = classifyTimeControl('3599+0');
    expect(r.category).toBe('rapid');
  });

  it('edge case: 180s пограничный — blitz', () => {
    expect(classifyTimeControl('180+0').category).toBe('blitz');
    expect(classifyTimeControl('179+0').category).toBe('bullet');
  });
});

describe('classifyGame — интеграция TimeControl + blacklist', () => {
  it('Scenario: классическая партия 5400+30 → classical', () => {
    const r = classifyGame({ timeControl: '5400+30', site: 'Linares', event: 'Linares 2005' });
    expect(r.category).toBe('classical');
    expect(r.isClassical).toBe(true);
    expect(r.reason).toBe('explicit_classical_tc');
  });

  it('Scenario: Titled Tuesday на chess.com 180+1 → blitz (явный TC приоритетнее blacklist)', () => {
    const r = classifyGame({
      timeControl: '180+1',
      site: 'chess.com',
      event: 'Titled Tuesday late 23 Jan 2024',
    });
    expect(r.category).toBe('blitz');
    expect(r.isClassical).toBe(false);
    expect(r.reason).toBe('explicit_blitz_tc');
  });

  it('Scenario: старая партия 1995 без TimeControl, Site=Linares → classical-legacy', () => {
    const r = classifyGame({ timeControl: null, site: 'Linares', event: 'Linares 1995' });
    expect(r.category).toBe('classical-legacy');
    expect(r.isClassical).toBe(true);
    expect(r.reason).toBe('legacy_otb');
  });

  it('Scenario: COVID Online Olympiad 5400+30 на lichess → classical (override blacklist)', () => {
    const r = classifyGame({
      timeControl: '5400+30',
      site: 'lichess.org',
      event: 'FIDE Online Olympiad 2020',
    });
    expect(r.category).toBe('classical');
    expect(r.isClassical).toBe(true);
    expect(r.reason).toBe('explicit_classical_tc');
  });

  it('Unknown TC + Site=chess.com → online-unknown (blacklist_site)', () => {
    const r = classifyGame({ timeControl: null, site: 'chess.com', event: 'Bullet Arena' });
    expect(r.category).toBe('online-unknown');
    expect(r.isClassical).toBe(false);
    expect(r.reason).toBe('blacklist_site');
  });

  it('Unknown TC + Event=Titled Tuesday → online-unknown (blacklist_event)', () => {
    const r = classifyGame({
      timeControl: '-',
      site: 'Internet',
      event: 'Titled Tuesday 1 Feb 2022',
    });
    expect(r.category).toBe('online-unknown');
    expect(r.reason).toBe('blacklist_event');
  });

  it('Correspondence 1/86400 → correspondence', () => {
    const r = classifyGame({ timeControl: '1/86400', site: null, event: null });
    expect(r.category).toBe('correspondence');
    expect(r.isClassical).toBe(false);
    expect(r.reason).toBe('explicit_correspondence_tc');
  });

  it('Case-insensitive blacklist match', () => {
    const r = classifyGame({
      timeControl: null,
      site: 'LICHESS.ORG',
      event: null,
    });
    expect(r.category).toBe('online-unknown');
    expect(r.reason).toBe('blacklist_site');
  });
});

describe('deriveArchiveTimeControlCategory (KS-2131)', () => {
  it('classical и classical-legacy → "classical" (TWIC без TimeControl-тега не теряем)', () => {
    expect(
      deriveArchiveTimeControlCategory(
        classifyGame({ timeControl: '5400+30', site: 'Wijk', event: 'Tata Steel' }),
        'Tata Steel Masters 2026',
      ),
    ).toBe('classical');
    expect(
      deriveArchiveTimeControlCategory(
        classifyGame({ timeControl: null, site: 'Linares', event: 'Linares 1995' }),
        'Linares 1995',
      ),
    ).toBe('classical');
  });

  it('явный rapid/blitz/bullet TC → одноимённая категория', () => {
    expect(
      deriveArchiveTimeControlCategory(
        classifyGame({ timeControl: '900+10', site: null, event: null }),
        null,
      ),
    ).toBe('rapid');
    expect(
      deriveArchiveTimeControlCategory(
        classifyGame({ timeControl: '180+1', site: 'chess.com', event: 'Titled Tuesday' }),
        'Titled Tuesday',
      ),
    ).toBe('blitz');
    expect(
      deriveArchiveTimeControlCategory(
        classifyGame({ timeControl: '60+0', site: null, event: null }),
        null,
      ),
    ).toBe('bullet');
  });

  it('online-unknown + Titled Tuesday → blitz (главный кейс KS-2131)', () => {
    const c = classifyGame({
      timeControl: null,
      site: 'chess.com',
      event: 'Titled Tuesday Blitz 21st Apr 2026',
    });
    expect(c.category).toBe('online-unknown');
    expect(deriveArchiveTimeControlCategory(c, 'Titled Tuesday Blitz 21st Apr 2026')).toBe('blitz');
  });

  it('online-unknown + Bullet Brawl → bullet (bullet проверяется до blitz)', () => {
    const c = classifyGame({
      timeControl: '-',
      site: 'chess.com',
      event: 'Titled Tuesday Bullet Brawl',
    });
    expect(c.category).toBe('online-unknown');
    expect(deriveArchiveTimeControlCategory(c, 'Titled Tuesday Bullet Brawl')).toBe('bullet');
  });

  it('online-unknown + Speed Chess / Arena Titled → blitz', () => {
    const speedChess = classifyGame({
      timeControl: '?',
      site: 'chess.com',
      event: 'Speed Chess Championship',
    });
    expect(deriveArchiveTimeControlCategory(speedChess, 'Speed Chess Championship')).toBe('blitz');
    const arena = classifyGame({
      timeControl: null,
      site: 'lichess.org',
      event: 'Arena Titled #142',
    });
    expect(deriveArchiveTimeControlCategory(arena, 'Arena Titled #142')).toBe('blitz');
  });

  it('online-unknown без Event-маркера → unknown', () => {
    const c = classifyGame({
      timeControl: null,
      site: 'chess.com',
      event: 'Random Casual Game',
    });
    expect(c.category).toBe('online-unknown');
    expect(deriveArchiveTimeControlCategory(c, 'Random Casual Game')).toBe('unknown');
  });

  it('online-unknown с пустым Event → unknown', () => {
    const c = classifyGame({ timeControl: null, site: 'chess.com', event: null });
    expect(c.category).toBe('online-unknown');
    expect(deriveArchiveTimeControlCategory(c, null)).toBe('unknown');
    expect(deriveArchiveTimeControlCategory(c, '')).toBe('unknown');
  });

  it('correspondence → unknown (не отдельная архив-категория)', () => {
    expect(
      deriveArchiveTimeControlCategory(
        classifyGame({ timeControl: '1/86400', site: null, event: null }),
        null,
      ),
    ).toBe('unknown');
  });

  it('Event-эвристика регистронезависимая', () => {
    const upper = classifyGame({
      timeControl: null,
      site: 'chess.com',
      event: 'TITLED TUESDAY',
    });
    expect(deriveArchiveTimeControlCategory(upper, 'TITLED TUESDAY')).toBe('blitz');
    const upperBullet = classifyGame({
      timeControl: null,
      site: 'chess.com',
      event: 'BULLET ARENA',
    });
    expect(deriveArchiveTimeControlCategory(upperBullet, 'BULLET ARENA')).toBe('bullet');
  });
});
