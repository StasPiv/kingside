/**
 * KS-4471 / ADR-140 T5. Unit-тесты HTML-strip и URL-count для
 * пользовательских комментариев.
 */
import { countUrls, stripHtml } from './comment-sanitize';

describe('stripHtml', () => {
  it('пустой вход → пустая строка', () => {
    expect(stripHtml('')).toBe('');
  });

  it('plain text возвращается как есть', () => {
    expect(stripHtml('hello world')).toBe('hello world');
  });

  it('вырезает обычные теги, оставляет содержимое', () => {
    expect(stripHtml('<p>hello <b>world</b></p>')).toBe('hello world');
  });

  it('вырезает <script>...</script> вместе с содержимым', () => {
    expect(stripHtml('a<script>alert(1)</script>b')).toBe('ab');
  });

  it('вырезает <style>...</style> вместе с содержимым', () => {
    expect(stripHtml('x<style>body{color:red}</style>y')).toBe('xy');
  });

  it('вырезает HTML-комментарии', () => {
    expect(stripHtml('a<!-- secret -->b')).toBe('ab');
  });

  it('атака «закодированный script» — двойной strip вычищает и оживлённый тег целиком', () => {
    // На входе literal `&lt;script&gt;alert(1)&lt;/script&gt;`. Первый
    // strip ничего не делает (нет `<>`), `decodeEntities` оживляет
    // `<script>...</script>`, второй strip ловит script-блок целиком
    // (включая содержимое) — так задумано, иначе плейлоад утёк бы в БД.
    const input = '&lt;script&gt;alert(1)&lt;/script&gt;';
    const out = stripHtml(input);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('</script');
    expect(out).not.toContain('alert(1)');
    expect(out).toBe('');
  });

  it('декодирует именованные entity', () => {
    expect(stripHtml('a&amp;b')).toBe('a&b');
    expect(stripHtml('a&nbsp;b')).toBe('a b');
    expect(stripHtml('&quot;hi&quot;')).toBe('"hi"');
  });

  it('декодирует числовые entity (dec и hex)', () => {
    expect(stripHtml('&#65;&#x42;')).toBe('AB');
  });

  it('нормализует whitespace, сохраняет один перевод строки', () => {
    expect(stripHtml('a\n\n\nb')).toBe('a\n\nb');
    expect(stripHtml('a   b')).toBe('a b');
    expect(stripHtml('  hi  ')).toBe('hi');
  });
});

describe('countUrls', () => {
  it('пустой ввод → 0', () => {
    expect(countUrls('')).toBe(0);
  });

  it('plain text без URL → 0', () => {
    expect(countUrls('hello world')).toBe(0);
  });

  it('один http(s) URL → 1', () => {
    expect(countUrls('see http://x.test')).toBe(1);
    expect(countUrls('see https://kingside.site/foo')).toBe(1);
  });

  it('bare www.… считается URL', () => {
    expect(countUrls('go to www.example.com please')).toBe(1);
  });

  it('два URL → 2', () => {
    expect(countUrls('one https://a.test two http://b.test')).toBe(2);
  });

  it('три URL → 3 (граничит с лимитом ≤ 2)', () => {
    expect(
      countUrls(
        'https://a.test https://b.test https://c.test',
      ),
    ).toBe(3);
  });

  it('https://kingside.site в разных регистрах считается', () => {
    expect(countUrls('HTTPS://X.test and www.Foo.com')).toBe(2);
  });
});
