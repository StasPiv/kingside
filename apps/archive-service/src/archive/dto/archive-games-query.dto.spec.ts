/**
 * KS-2081 — `ArchiveGamesQueryDto.player` принимает `string | string[]`
 * и нормализуется в массив через class-transformer @Transform.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ArchiveGamesQueryDto } from './archive-games-query.dto';

describe('ArchiveGamesQueryDto.player — KS-2081', () => {
  it('одиночный string → массив длины 1', async () => {
    const dto = plainToInstance(ArchiveGamesQueryDto, { player: 'Carlsen' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(Array.isArray(dto.player)).toBe(true);
    expect(dto.player).toEqual(['Carlsen']);
  });

  it('массив string[] остаётся массивом', async () => {
    const dto = plainToInstance(ArchiveGamesQueryDto, {
      player: ['Carlsen,M', 'Caruana,F'],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.player).toEqual(['Carlsen,M', 'Caruana,F']);
  });

  it('undefined → undefined (не падает)', async () => {
    const dto = plainToInstance(ArchiveGamesQueryDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.player).toBeUndefined();
  });

  it('массив > 5 элементов → ошибка ArrayMaxSize', async () => {
    const dto = plainToInstance(ArchiveGamesQueryDto, {
      player: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toMatch(/arrayMaxSize/);
  });

  it('элемент массива не строка → ошибка IsString({each:true})', async () => {
    const dto = plainToInstance(ArchiveGamesQueryDto, {
      player: ['Carlsen', 123 as unknown as string],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toMatch(/isString/);
  });
});
