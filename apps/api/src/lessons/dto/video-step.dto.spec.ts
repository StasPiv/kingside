/**
 * Unit-тесты DTO `VideoStepPayloadDto` (KS-1808 / L-34).
 *
 * Покрытие по Gherkin:
 *   - валидный YouTube URL;
 *   - валидный Vimeo URL;
 *   - невалидный хост (`example.com`);
 *   - не-URL;
 *   - `javascript:` URL;
 *   - пустая строка.
 */

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VideoStepPayloadDto } from './step-payload.dto';

async function validatePayload(payload: unknown): Promise<string[]> {
  const instance = plainToInstance(VideoStepPayloadDto, payload);
  const errors = await validate(instance as object, {
    whitelist: true,
    forbidUnknownValues: false,
  });
  const out: string[] = [];
  for (const e of errors) {
    for (const msg of Object.values(e.constraints ?? {})) out.push(`${e.property}: ${msg}`);
  }
  return out;
}

describe('VideoStepPayloadDto', () => {
  it('валидный YouTube (youtube.com/watch?v=...) — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      titleI18nKey: 'lessons.beginner.video.title',
    });
    expect(errors).toEqual([]);
  });

  it('валидный YouTube short (youtu.be/<id>) — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: 'https://youtu.be/dQw4w9WgXcQ',
    });
    expect(errors).toEqual([]);
  });

  it('валидный YouTube nocookie-embed — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    });
    expect(errors).toEqual([]);
  });

  it('валидный Vimeo (vimeo.com/<id>) — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: 'https://vimeo.com/76979871',
    });
    expect(errors).toEqual([]);
  });

  it('валидный Vimeo player — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: 'https://player.vimeo.com/video/76979871',
    });
    expect(errors).toEqual([]);
  });

  it('невалидный хост (example.com) — ошибка на url', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: 'https://example.com/watch?v=1',
    });
    expect(errors.some((m) => m.startsWith('url:'))).toBe(true);
  });

  it('субдомен vimeo.something.com не проходит (точный whitelist)', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: 'https://vimeo.malicious.com/video/1',
    });
    expect(errors.some((m) => m.startsWith('url:'))).toBe(true);
  });

  it('не-URL (простая строка) — ошибка на url', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: 'not-a-url',
    });
    expect(errors.some((m) => m.startsWith('url:'))).toBe(true);
  });

  it('javascript: URL — ошибка на url (protocol отбивается)', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: 'javascript:alert(1)',
    });
    expect(errors.some((m) => m.startsWith('url:'))).toBe(true);
  });

  it('пустая строка — ошибка на url', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: '',
    });
    expect(errors.some((m) => m.startsWith('url:'))).toBe(true);
  });

  it('неверный type (не video) — ошибка на type', async () => {
    const errors = await validatePayload({
      type: 'text',
      url: 'https://www.youtube.com/watch?v=x',
    });
    expect(errors.some((m) => m.startsWith('type:'))).toBe(true);
  });

  it('titleI18nKey опционален', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: 'https://youtu.be/abc',
    });
    expect(errors).toEqual([]);
  });

  it('host сравнивается регистронезависимо', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: 'https://WWW.YOUTUBE.COM/watch?v=abc',
    });
    expect(errors).toEqual([]);
  });

  it('http:// валидного хоста тоже допустим', async () => {
    const errors = await validatePayload({
      type: 'video',
      url: 'http://youtube.com/watch?v=abc',
    });
    expect(errors).toEqual([]);
  });
});
