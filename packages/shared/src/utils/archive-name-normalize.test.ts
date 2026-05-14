/**
 * KS-2064 — архивная нормализация имён.
 */
import { describe, it, expect } from 'vitest';
import {
  archiveSlug,
  normalizeArchiveName,
} from './archive-name-normalize.js';

describe('normalizeArchiveName', () => {
  it('lowercase', () => {
    expect(normalizeArchiveName('CARLSEN')).toBe('carlsen');
  });

  it('убирает диакритику (NFKD + combining marks)', () => {
    expect(normalizeArchiveName('Müller')).toBe('muller');
    expect(normalizeArchiveName('Caruana, Néstor')).toBe('caruana nestor');
    expect(normalizeArchiveName('Vallejo Pons, Francisco')).toBe(
      'vallejo pons francisco',
    );
    // Восстанавливаемая Cyrillic-диакритика типа Е́ → е
    expect(normalizeArchiveName('Карякин')).toBe('карякин');
  });

  it('заменяет пунктуацию на пробел', () => {
    expect(normalizeArchiveName('Carlsen, Magnus')).toBe('carlsen magnus');
    expect(normalizeArchiveName('Carlsen,M.')).toBe('carlsen m');
    expect(normalizeArchiveName("O'Donnell")).toBe('o donnell');
    expect(normalizeArchiveName('Smith-Jones')).toBe('smith jones');
    expect(normalizeArchiveName('Vasiljev_S.')).toBe('vasiljev s');
    expect(normalizeArchiveName('Doe; J.')).toBe('doe j');
  });

  it('сворачивает множественные пробелы и trim', () => {
    expect(normalizeArchiveName('  Carlsen ,  Magnus  ')).toBe('carlsen magnus');
    expect(normalizeArchiveName('A\t\tB')).toBe('a b');
    expect(normalizeArchiveName('A\nB')).toBe('a b');
  });

  it('идемпотентная: norm(norm(x)) === norm(x)', () => {
    const samples = ['Carlsen, Magnus', 'Müller', 'Карякин', "O'Donnell"];
    for (const s of samples) {
      const once = normalizeArchiveName(s);
      const twice = normalizeArchiveName(once);
      expect(twice).toBe(once);
    }
  });

  it('пустой вход / non-string → ""', () => {
    expect(normalizeArchiveName('')).toBe('');
    expect(normalizeArchiveName('   ')).toBe('');
    expect(normalizeArchiveName('....,,,')).toBe('');
    // @ts-expect-error — проверяем защиту от runtime-мусора
    expect(normalizeArchiveName(null)).toBe('');
    // @ts-expect-error — проверяем защиту от runtime-мусора
    expect(normalizeArchiveName(undefined)).toBe('');
  });

  it('варианты «Carlsen,M.» и «Carlsen, M» сводятся к одной форме', () => {
    expect(normalizeArchiveName('Carlsen,M.')).toBe(
      normalizeArchiveName('Carlsen, M'),
    );
    expect(normalizeArchiveName('Carlsen,M.')).toBe(
      normalizeArchiveName('Carlsen , M.'),
    );
  });
});

describe('archiveSlug', () => {
  it('пробелы → дефисы', () => {
    expect(archiveSlug('Carlsen, Magnus')).toBe('carlsen-magnus');
    expect(archiveSlug('Vallejo Pons, Francisco')).toBe('vallejo-pons-francisco');
  });

  it('идемпотентен: slug(slug(x)) === slug(x)', () => {
    const slugged = archiveSlug('Carlsen, Magnus');
    expect(archiveSlug(slugged)).toBe(slugged);
  });

  it('одинаковый slug для разных форм одного имени', () => {
    expect(archiveSlug('Carlsen, Magnus')).toBe(archiveSlug('Carlsen,Magnus'));
    expect(archiveSlug('Carlsen, Magnus')).toBe(archiveSlug('  CARLSEN ,  MAGNUS  '));
  });

  it('пустой / мусорный вход → ""', () => {
    expect(archiveSlug('')).toBe('');
    expect(archiveSlug(',,,')).toBe('');
    expect(archiveSlug('   ')).toBe('');
  });
});
