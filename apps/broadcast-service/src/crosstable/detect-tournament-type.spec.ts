import { detectTournamentType } from './detect-tournament-type';

/**
 * KS-1727 / ADR-023 §2.2.4 — спека на маппинг `Broadcast.format` в
 * `TournamentType`. Чистая функция, поэтому никакой DI/моков.
 */
describe('detectTournamentType', () => {
  describe('реальные примеры из Lichess (приёмочные кейсы тикета)', () => {
    it('"16-team round-robin" → team-round-robin', () => {
      expect(detectTournamentType({ format: '16-team round-robin' })).toBe(
        'team-round-robin',
      );
    });

    it('"9-round Swiss" → swiss', () => {
      expect(detectTournamentType({ format: '9-round Swiss' })).toBe('swiss');
    });

    it('"9-round Swiss for teams" → team-swiss', () => {
      expect(detectTournamentType({ format: '9-round Swiss for teams' })).toBe(
        'team-swiss',
      );
    });

    it('"Match" → unknown (v1 не распознаёт матчевый формат)', () => {
      expect(detectTournamentType({ format: 'Match' })).toBe('unknown');
    });

    it('"Knockout" → unknown (v1 не распознаёт knockout)', () => {
      expect(detectTournamentType({ format: 'Knockout' })).toBe('unknown');
    });

    it('null → unknown', () => {
      expect(detectTournamentType({ format: null })).toBe('unknown');
    });

    it('"" → unknown', () => {
      expect(detectTournamentType({ format: '' })).toBe('unknown');
    });
  });

  describe('round-robin variants', () => {
    it('"12-player round-robin" → round-robin', () => {
      expect(detectTournamentType({ format: '12-player round-robin' })).toBe(
        'round-robin',
      );
    });

    it('"10-player double round-robin" → round-robin (v1: матрица та же)', () => {
      // ADR-023 §2.2.4: в v1 double-round-robin рендерится той же матрицей,
      // что обычный round-robin (с двумя клетками на пару). Отдельный
      // рендер — v1.1.
      expect(detectTournamentType({ format: '10-player double round-robin' })).toBe(
        'round-robin',
      );
    });

    it('regex /round[- ]?robin/i ловит "round robin" (с пробелом)', () => {
      expect(detectTournamentType({ format: 'round robin masters' })).toBe(
        'round-robin',
      );
    });

    it('regex /round[- ]?robin/i ловит "roundrobin" (слитно)', () => {
      expect(detectTournamentType({ format: '8-player roundrobin' })).toBe(
        'round-robin',
      );
    });
  });

  describe('case-insensitivity', () => {
    it('"SWISS" (всё капсом) → swiss', () => {
      expect(detectTournamentType({ format: 'SWISS' })).toBe('swiss');
    });

    it('"Round-Robin" с CamelCase → round-robin', () => {
      expect(detectTournamentType({ format: 'Round-Robin' })).toBe(
        'round-robin',
      );
    });

    it('"TEAM SWISS" (всё капсом) → team-swiss', () => {
      expect(detectTournamentType({ format: 'TEAM SWISS' })).toBe('team-swiss');
    });
  });

  describe('hasTeamTable flag (override без /team/ в format)', () => {
    it('format="9-round Swiss" + hasTeamTable=true → team-swiss', () => {
      // ADR-023 §2.2.4 правило 1: «/team/i в format ИЛИ teamTable=true».
      expect(
        detectTournamentType({ format: '9-round Swiss', hasTeamTable: true }),
      ).toBe('team-swiss');
    });

    it('format="round-robin" + hasTeamTable=true → team-round-robin', () => {
      expect(
        detectTournamentType({ format: 'round-robin', hasTeamTable: true }),
      ).toBe('team-round-robin');
    });

    it('format="9-round Swiss" + hasTeamTable=false → swiss (no override)', () => {
      expect(
        detectTournamentType({ format: '9-round Swiss', hasTeamTable: false }),
      ).toBe('swiss');
    });

    it('format="9-round Swiss" без hasTeamTable → swiss (default false)', () => {
      expect(detectTournamentType({ format: '9-round Swiss' })).toBe('swiss');
    });

    it('hasTeamTable=true но format=null → unknown (нет базового формата)', () => {
      // Team-сигнал есть, но без знания базового формата (swiss/RR) тип
      // классифицировать нельзя — возвращаем unknown, fallback на legacy.
      expect(detectTournamentType({ format: null, hasTeamTable: true })).toBe(
        'unknown',
      );
    });
  });

  describe('priority: team-prefix перекрывает чистый swiss/round-robin', () => {
    it('"9-round Swiss for teams" → team-swiss (не swiss)', () => {
      // Регрессионная защита: если порядок проверок изменится и /swiss/
      // сматчит первым, кейс свалится на 'swiss' вместо 'team-swiss'.
      expect(detectTournamentType({ format: '9-round Swiss for teams' })).toBe(
        'team-swiss',
      );
    });

    it('"Team round-robin Bundesliga" → team-round-robin (не round-robin)', () => {
      expect(
        detectTournamentType({ format: 'Team round-robin Bundesliga' }),
      ).toBe('team-round-robin');
    });
  });

  describe('N Round Team Tournament (KS-2207)', () => {
    it('"11 Round Team Tournament" → team-swiss', () => {
      expect(detectTournamentType({ format: '11 Round Team Tournament' })).toBe(
        'team-swiss',
      );
    });

    it('"7 Round Team Tournament" → team-swiss', () => {
      expect(detectTournamentType({ format: '7 Round Team Tournament' })).toBe(
        'team-swiss',
      );
    });

    it('"11 round team tournament" (lowercase) → team-swiss', () => {
      expect(
        detectTournamentType({ format: '11 round team tournament' }),
      ).toBe('team-swiss');
    });
  });

  describe('whitespace-only / unknown formats', () => {
    it('"   " (только whitespace) → unknown', () => {
      expect(detectTournamentType({ format: '   ' })).toBe('unknown');
    });

    it('"Scheveningen" → unknown (v1.1)', () => {
      expect(detectTournamentType({ format: 'Scheveningen' })).toBe('unknown');
    });

    it('"12-game match" → unknown (v1.1)', () => {
      expect(detectTournamentType({ format: '12-game match' })).toBe('unknown');
    });
  });
});
