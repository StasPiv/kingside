import { describe, expect, it } from 'vitest';
import { parseArgs } from './backfill.js';

describe('backfill parseArgs', () => {
  it('без аргументов → mode=default, batch 2000, resume=null', () => {
    const opts = parseArgs([]);
    expect(opts).toEqual({
      mode: 'default',
      batchSize: 2000,
      resumeFrom: null,
    });
  });

  it('--mode=extend → mode=extend', () => {
    expect(parseArgs(['--mode=extend']).mode).toBe('extend');
  });

  it('--mode=default явно → mode=default', () => {
    expect(parseArgs(['--mode=default']).mode).toBe('default');
  });

  it('--ignore-existing-game-ids → mode=extend (алиас из ТЗ)', () => {
    expect(parseArgs(['--ignore-existing-game-ids']).mode).toBe('extend');
  });

  it('--mode=unknown бросает ошибку', () => {
    expect(() => parseArgs(['--mode=bad'])).toThrow(/Unknown --mode=bad/);
  });

  it('--batch-size=500 применяется', () => {
    expect(parseArgs(['--batch-size=500']).batchSize).toBe(500);
  });

  it('--batch-size=0 бросает ошибку', () => {
    expect(() => parseArgs(['--batch-size=0'])).toThrow(/Invalid --batch-size/);
  });

  it('--batch-size=abc бросает ошибку', () => {
    expect(() => parseArgs(['--batch-size=abc'])).toThrow(/Invalid --batch-size/);
  });

  it('--resume-from=<uuid> применяется', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(parseArgs([`--resume-from=${uuid}`]).resumeFrom).toBe(uuid);
  });

  it('--resume-from= (пусто) → null', () => {
    expect(parseArgs(['--resume-from=']).resumeFrom).toBeNull();
  });

  it('комбинация: --mode=extend --batch-size=1000 --resume-from=<uuid>', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(
      parseArgs([
        '--mode=extend',
        '--batch-size=1000',
        `--resume-from=${uuid}`,
      ]),
    ).toEqual({
      mode: 'extend',
      batchSize: 1000,
      resumeFrom: uuid,
    });
  });

  it('неизвестные флаги игнорируются', () => {
    const opts = parseArgs(['--foo=bar', '--mode=extend']);
    expect(opts.mode).toBe('extend');
  });
});
