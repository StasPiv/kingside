/**
 * KS-4605. Юнит-тесты CLI-парсера `generate-tactic-puzzles-from-twic`.
 * Покрытие: обязательность scope-флага, валидация значений, взаимоисключение,
 * сборка `TacticGenRunOptions`.
 */
import { parseArgs } from './generate-tactic-puzzles-from-twic.cli';

describe('generate-tactic-puzzles-from-twic CLI parser — KS-4605', () => {
  const UUID_A = '11111111-1111-4111-a111-111111111111';
  const UUID_B = '22222222-2222-4222-a222-222222222222';

  describe('обязательный scope', () => {
    it('без --twic-issue/--import-id/--all — ошибка', () => {
      expect(() => parseArgs([])).toThrow(/one of --twic-issue/);
    });

    it('одинокие технические флаги — ошибка', () => {
      expect(() => parseArgs(['--limit=100', '--dry-run'])).toThrow(
        /scope of generation must be explicit/,
      );
    });
  });

  describe('--twic-issue', () => {
    it('задаёт twicIssue, importIds=null', () => {
      const { options } = parseArgs(['--twic-issue=1650']);
      expect(options.twicIssue).toBe(1650);
      expect(options.importIds).toBeNull();
      expect(options.fullBacklog).toBe(false);
    });

    it('некорректное значение → ошибка', () => {
      expect(() => parseArgs(['--twic-issue=abc'])).toThrow(/bad --twic-issue/);
      expect(() => parseArgs(['--twic-issue=0'])).toThrow(/bad --twic-issue/);
      expect(() => parseArgs(['--twic-issue=-5'])).toThrow(/bad --twic-issue/);
    });
  });

  describe('--import-id', () => {
    it('один UUID', () => {
      const { options } = parseArgs([`--import-id=${UUID_A}`]);
      expect(options.importIds).toEqual([UUID_A]);
      expect(options.twicIssue).toBeNull();
    });

    it('повторяющийся флаг — массив (retry-импорты)', () => {
      const { options } = parseArgs([
        `--import-id=${UUID_A}`,
        `--import-id=${UUID_B}`,
      ]);
      expect(options.importIds).toEqual([UUID_A, UUID_B]);
    });

    it('некорректный UUID → ошибка', () => {
      expect(() => parseArgs(['--import-id=not-a-uuid'])).toThrow(
        /bad --import-id/,
      );
    });

    it('upper-case UUID нормализуется в lower', () => {
      const { options } = parseArgs([`--import-id=${UUID_A.toUpperCase()}`]);
      expect(options.importIds).toEqual([UUID_A]);
    });
  });

  describe('--all / --full-backlog', () => {
    it('--all → fullBacklog=true', () => {
      const { options } = parseArgs(['--all']);
      expect(options.fullBacklog).toBe(true);
      expect(options.importIds).toBeNull();
      expect(options.twicIssue).toBeNull();
    });

    it('--full-backlog — синоним', () => {
      const { options } = parseArgs(['--full-backlog']);
      expect(options.fullBacklog).toBe(true);
    });
  });

  describe('взаимоисключение scope-флагов', () => {
    it('--twic-issue + --import-id → ошибка', () => {
      expect(() =>
        parseArgs(['--twic-issue=1650', `--import-id=${UUID_A}`]),
      ).toThrow(/mutually exclusive/);
    });

    it('--twic-issue + --all → ошибка', () => {
      expect(() => parseArgs(['--twic-issue=1650', '--all'])).toThrow(
        /mutually exclusive/,
      );
    });

    it('--import-id + --all → ошибка', () => {
      expect(() =>
        parseArgs([`--import-id=${UUID_A}`, '--all']),
      ).toThrow(/mutually exclusive/);
    });
  });

  describe('сочетание со scope', () => {
    it('--twic-issue + --shard-index/--shard-count', () => {
      const { options } = parseArgs([
        '--twic-issue=1650',
        '--shard-index=3',
        '--shard-count=8',
      ]);
      expect(options.twicIssue).toBe(1650);
      expect(options.shardIndex).toBe(3);
      expect(options.shardCount).toBe(8);
    });

    it('--shard-index без --shard-count → ошибка (как раньше)', () => {
      expect(() =>
        parseArgs(['--twic-issue=1650', '--shard-index=3']),
      ).toThrow(/--shard-index and --shard-count must be set together/);
    });

    it('--all + --limit=none', () => {
      const { options } = parseArgs(['--all', '--limit=none']);
      expect(options.fullBacklog).toBe(true);
      expect(options.limit).toBeNull();
    });
  });

  describe('default-значения', () => {
    it('limit по умолчанию 100', () => {
      const { options } = parseArgs(['--twic-issue=1650']);
      expect(options.limit).toBe(100);
    });

    it('--limit=none → null', () => {
      const { options } = parseArgs(['--all', '--limit=none']);
      expect(options.limit).toBeNull();
    });
  });
});
