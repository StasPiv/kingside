/**
 * KS-4446 / ADR-138 §7. Юнит-тесты на трансформеры multipart-DTO.
 *
 * Проверяем чистые helper'ы `parseTagsArray` / `parseBooleanFlag`
 * (контракт с фронтом) и end-to-end через `plainToInstance` +
 * `validate` для `CreateBlogPostDto` / `UpdateBlogPostDto` —
 * убеждаемся, что трансформеры применены к нужным полям и не
 * ломают чистый JSON-режим.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import {
  CreateBlogPostDto,
  UpdateBlogPostDto,
  parseBooleanFlag,
  parseTagsArray,
} from './blog-admin.dto';

const VALID_BASE = {
  slug: 'my-post',
  locale: 'ru',
  title: 'T',
  description: 'D',
  bodyMd: '# h',
  authorId: '11111111-1111-4111-a111-111111111111',
};

describe('parseTagsArray', () => {
  it('массив остаётся массивом', () => {
    expect(parseTagsArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('undefined / null пропускаются', () => {
    expect(parseTagsArray(undefined)).toBeUndefined();
    expect(parseTagsArray(null)).toBeNull();
  });

  it('пустая строка → undefined (поле не задано)', () => {
    expect(parseTagsArray('')).toBeUndefined();
    expect(parseTagsArray('   ')).toBeUndefined();
  });

  it('валидная JSON-строка массива → массив', () => {
    expect(parseTagsArray('["a","b","c"]')).toEqual(['a', 'b', 'c']);
  });

  it('JSON-строка с пустым массивом', () => {
    expect(parseTagsArray('[]')).toEqual([]);
  });

  it('невалидная JSON-строка → 400 BadRequestException', () => {
    expect(() => parseTagsArray('not-json')).toThrow(BadRequestException);
    expect(() => parseTagsArray('[a,b,c]')).toThrow(BadRequestException);
  });

  it('валидный JSON, но не массив → 400 BadRequestException', () => {
    expect(() => parseTagsArray('{"a":1}')).toThrow(BadRequestException);
    expect(() => parseTagsArray('"a-string"')).toThrow(BadRequestException);
    expect(() => parseTagsArray('42')).toThrow(BadRequestException);
  });

  it('число/объект — возвращается как есть (поймает @IsArray позже)', () => {
    expect(parseTagsArray(42)).toBe(42);
    expect(parseTagsArray({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('parseBooleanFlag', () => {
  it('boolean остаётся boolean', () => {
    expect(parseBooleanFlag(true)).toBe(true);
    expect(parseBooleanFlag(false)).toBe(false);
  });

  it('truthy строки → true', () => {
    expect(parseBooleanFlag('true')).toBe(true);
    expect(parseBooleanFlag('1')).toBe(true);
    expect(parseBooleanFlag('on')).toBe(true);
  });

  it('falsy строки → false', () => {
    expect(parseBooleanFlag('false')).toBe(false);
    expect(parseBooleanFlag('0')).toBe(false);
    expect(parseBooleanFlag('off')).toBe(false);
    expect(parseBooleanFlag('')).toBe(false);
  });

  it('неизвестное → как есть (поймает @IsBoolean позже)', () => {
    expect(parseBooleanFlag('yes')).toBe('yes');
    expect(parseBooleanFlag(42)).toBe(42);
  });
});

describe('CreateBlogPostDto.tags transform', () => {
  it('JSON-режим: массив → массив, validate проходит', async () => {
    const dto = plainToInstance(CreateBlogPostDto, {
      ...VALID_BASE,
      tags: ['intro', 'engine'],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.tags).toEqual(['intro', 'engine']);
  });

  it('multipart: JSON-строка → распарсенный массив', async () => {
    const dto = plainToInstance(CreateBlogPostDto, {
      ...VALID_BASE,
      tags: '["intro","engine"]',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.tags).toEqual(['intro', 'engine']);
  });

  it('multipart: невалидный JSON → 400', () => {
    expect(() =>
      plainToInstance(CreateBlogPostDto, {
        ...VALID_BASE,
        tags: 'not-an-array',
      }),
    ).toThrow(BadRequestException);
  });

  it('пустая строка → undefined (валидация не падает на отсутствии)', async () => {
    const dto = plainToInstance(CreateBlogPostDto, {
      ...VALID_BASE,
      tags: '',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.tags).toBeUndefined();
  });

  it('JSON-объект (не массив) → 400', () => {
    expect(() =>
      plainToInstance(CreateBlogPostDto, {
        ...VALID_BASE,
        tags: '{"a":1}',
      }),
    ).toThrow(BadRequestException);
  });
});

describe('UpdateBlogPostDto.tags transform', () => {
  it('JSON-строка массива → распарсенный массив', async () => {
    const dto = plainToInstance(UpdateBlogPostDto, {
      tags: '["a","b"]',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.tags).toEqual(['a', 'b']);
  });

  it('массив → как есть', async () => {
    const dto = plainToInstance(UpdateBlogPostDto, {
      tags: ['x'],
    });
    expect(dto.tags).toEqual(['x']);
  });
});

describe('UpdateBlogPostDto.coverReset transform', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['on', true],
    ['false', false],
    ['0', false],
    ['off', false],
    ['', false],
    [true, true],
    [false, false],
  ])('coverReset=%j → %j (валиден)', async (input, expected) => {
    const dto = plainToInstance(UpdateBlogPostDto, {
      coverReset: input as unknown,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.coverReset).toBe(expected);
  });

  it('coverReset=невалидная_строка → @IsBoolean ошибка', async () => {
    const dto = plainToInstance(UpdateBlogPostDto, {
      coverReset: 'maybe' as unknown,
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('coverReset');
  });
});
