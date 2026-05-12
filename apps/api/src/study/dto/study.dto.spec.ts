/**
 * KS-2856 / KS-2858 B2. Юнит-тесты DTO Studies Phase 2:
 *  - visibility whitelist;
 *  - topics: ArrayMaxSize + MaxLength per element;
 *  - mode whitelist (analysis/practice/conceal/gamebook);
 *  - concealPly / gamebook optional integers/objects.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateChapterDto,
  CreateStudyDto,
  UpdateChapterDto,
  UpdateStudyDto,
} from './study.dto';
import {
  STUDY_CHAPTER_MODES,
  STUDY_TOPIC_LENGTH_MAX,
  STUDY_TOPIC_MAX,
  STUDY_VISIBILITIES,
} from '../study-limits';

describe('CreateStudyDto — KS-2858 B2', () => {
  it.each(STUDY_VISIBILITIES)('valid visibility %s', async (v) => {
    const dto = plainToInstance(CreateStudyDto, {
      name: 'X',
      visibility: v,
    });
    expect(await validate(dto)).toEqual([]);
  });

  it('invalid visibility → constraint failure', async () => {
    const dto = plainToInstance(CreateStudyDto, {
      name: 'X',
      visibility: 'half-public',
    });
    const errors = await validate(dto);
    expect(errors.find((e) => e.property === 'visibility')).toBeDefined();
  });

  it('topics массив до лимита — ok', async () => {
    const dto = plainToInstance(CreateStudyDto, {
      name: 'X',
      topics: ['opening', 'endgame'],
    });
    expect(await validate(dto)).toEqual([]);
  });

  it('topics > max → ArrayMaxSize fail', async () => {
    const dto = plainToInstance(CreateStudyDto, {
      name: 'X',
      topics: new Array(STUDY_TOPIC_MAX + 1).fill('t'),
    });
    const errors = await validate(dto);
    expect(errors.find((e) => e.property === 'topics')).toBeDefined();
  });

  it('topics элемент слишком длинный → MaxLength fail', async () => {
    const dto = plainToInstance(CreateStudyDto, {
      name: 'X',
      topics: ['a'.repeat(STUDY_TOPIC_LENGTH_MAX + 1)],
    });
    const errors = await validate(dto);
    expect(errors.find((e) => e.property === 'topics')).toBeDefined();
  });

  it('topics не массив строк → fail', async () => {
    const dto = plainToInstance(CreateStudyDto, {
      name: 'X',
      topics: [123, 'ok'],
    });
    const errors = await validate(dto);
    expect(errors.find((e) => e.property === 'topics')).toBeDefined();
  });

  it('legacy isPublic + visibility оба допустимы (приоритет visibility)', async () => {
    const dto = plainToInstance(CreateStudyDto, {
      name: 'X',
      isPublic: true,
      visibility: 'unlisted',
    });
    expect(await validate(dto)).toEqual([]);
  });
});

describe('UpdateStudyDto — KS-2858 B2', () => {
  it('пустой объект — ok (partial)', async () => {
    expect(await validate(plainToInstance(UpdateStudyDto, {}))).toEqual([]);
  });

  it('частичный update только topics — ok', async () => {
    expect(
      await validate(
        plainToInstance(UpdateStudyDto, { topics: ['x'] }),
      ),
    ).toEqual([]);
  });
});

describe('CreateChapterDto — KS-2858 B2', () => {
  it.each(STUDY_CHAPTER_MODES)('valid mode %s', async (m) => {
    const dto = plainToInstance(CreateChapterDto, {
      name: 'C',
      mode: m,
    });
    expect(await validate(dto)).toEqual([]);
  });

  it('invalid mode → fail', async () => {
    const dto = plainToInstance(CreateChapterDto, {
      name: 'C',
      mode: 'puzzle',
    });
    const errors = await validate(dto);
    expect(errors.find((e) => e.property === 'mode')).toBeDefined();
  });

  it('concealPly целое неотрицательное — ok', async () => {
    expect(
      await validate(
        plainToInstance(CreateChapterDto, {
          name: 'C',
          mode: 'conceal',
          concealPly: 4,
        }),
      ),
    ).toEqual([]);
  });

  it('concealPly отрицательный → fail', async () => {
    const errors = await validate(
      plainToInstance(CreateChapterDto, {
        name: 'C',
        concealPly: -1,
      }),
    );
    expect(errors.find((e) => e.property === 'concealPly')).toBeDefined();
  });

  it('gamebook — объект (структуру валидирует validateGamebookPayload отдельно)', async () => {
    expect(
      await validate(
        plainToInstance(CreateChapterDto, {
          name: 'C',
          mode: 'gamebook',
          gamebook: { intro: 'go' },
        }),
      ),
    ).toEqual([]);
  });

  it('gamebook массив → fail (IsObject)', async () => {
    const errors = await validate(
      plainToInstance(CreateChapterDto, {
        name: 'C',
        gamebook: ['x'] as unknown as Record<string, unknown>,
      }),
    );
    expect(errors.find((e) => e.property === 'gamebook')).toBeDefined();
  });
});

describe('UpdateChapterDto — KS-2858 B2', () => {
  it('частичный update mode → ok', async () => {
    expect(
      await validate(
        plainToInstance(UpdateChapterDto, { mode: 'practice' }),
      ),
    ).toEqual([]);
  });

  it('concealPly: null допустим (явный сброс)', async () => {
    // class-validator @IsOptional пропускает null.
    expect(
      await validate(
        plainToInstance(UpdateChapterDto, { concealPly: null }),
      ),
    ).toEqual([]);
  });
});
