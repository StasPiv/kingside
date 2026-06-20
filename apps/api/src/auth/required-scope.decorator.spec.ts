/**
 * KS-4455 / ADR-139 §3. Юнит-тесты `hasScope` — wildcard и точные
 * совпадения.
 */
import { hasScope } from './required-scope.decorator';

describe('hasScope', () => {
  it('точное совпадение → true', () => {
    expect(hasScope(['blog:write'], 'blog:write')).toBe(true);
  });

  it('точное несовпадение → false', () => {
    expect(hasScope(['blog:write'], 'blog:read')).toBe(false);
  });

  it('пустой required → false', () => {
    expect(hasScope(['blog:*'], '')).toBe(false);
  });

  it('blog:* покрывает blog:write/blog:read', () => {
    expect(hasScope(['blog:*'], 'blog:write')).toBe(true);
    expect(hasScope(['blog:*'], 'blog:read')).toBe(true);
    expect(hasScope(['blog:*'], 'blog:delete')).toBe(true);
  });

  it('blog:* НЕ matches blog (без двоеточия)', () => {
    expect(hasScope(['blog:*'], 'blog')).toBe(false);
  });

  it('blog:* НЕ matches lessons:write', () => {
    expect(hasScope(['blog:*'], 'lessons:write')).toBe(false);
  });

  it('глобальный * matches всё', () => {
    expect(hasScope(['*'], 'blog:write')).toBe(true);
    expect(hasScope(['*'], 'lessons:read')).toBe(true);
    expect(hasScope(['*'], 'anything')).toBe(true);
  });

  it('пустой scopes → false', () => {
    expect(hasScope([], 'blog:write')).toBe(false);
  });

  it('несколько scopes, точное среди других → true', () => {
    expect(hasScope(['lessons:write', 'blog:write'], 'blog:write')).toBe(true);
  });

  it('несколько scopes, wildcard среди других → true', () => {
    expect(hasScope(['lessons:write', 'blog:*'], 'blog:read')).toBe(true);
  });

  it('required без двоеточия и нет в exact-списке → false', () => {
    expect(hasScope(['blog:*'], 'admin')).toBe(false);
  });

  it('required без двоеточия + admin в exact-списке → true', () => {
    expect(hasScope(['admin'], 'admin')).toBe(true);
  });
});
