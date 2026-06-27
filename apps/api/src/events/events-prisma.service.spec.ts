/**
 * KS-4695: unit-тест на сборку writer-URL. Подмена user/password в DSN
 * — единственная нетривиальная логика в `EventsPrismaService`.
 */
import { swapUserAndPassword } from './events-prisma.service';

describe('swapUserAndPassword', () => {
  it('меняет user и password, сохраняет хост/порт/db/query', () => {
    const dsn = 'postgresql://owner:secret@db.example.com:5432/kingside?schema=events&sslmode=require';
    const result = swapUserAndPassword(dsn, 'events_writer', 'P@ss/word!');
    const u = new URL(result);
    expect(u.username).toBe('events_writer');
    // URL.password всегда percent-encoded:
    expect(decodeURIComponent(u.password)).toBe('P@ss/word!');
    expect(u.hostname).toBe('db.example.com');
    expect(u.port).toBe('5432');
    expect(u.pathname).toBe('/kingside');
    expect(u.searchParams.get('schema')).toBe('events');
    expect(u.searchParams.get('sslmode')).toBe('require');
  });

  it('работает с DSN без пароля и без query', () => {
    const dsn = 'postgresql://owner@localhost:5432/kingside';
    const result = swapUserAndPassword(dsn, 'events_writer', 'pw');
    expect(result).toContain('events_writer');
    expect(result).toContain('pw');
    expect(new URL(result).pathname).toBe('/kingside');
  });
});
