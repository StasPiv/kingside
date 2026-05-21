/**
 * Unit-тесты `GameStepPayloadDto` (KS-3180 / ADR-072 §7 B1).
 *
 * Покрытие по Gherkin:
 *   - sourceType='pgn' + валидный PGN — ok;
 *   - sourceType='pgn' без pgn — ошибка;
 *   - sourceType='pgn' + analysisId — ошибка (XOR);
 *   - sourceType='workshop_analysis' + analysisId (UUID) — ok без pgn;
 *   - sourceType='workshop_analysis' без analysisId — ошибка;
 *   - sourceType='workshop_analysis' + невалидный UUID — ошибка;
 *   - неверный sourceType — ошибка;
 *   - неверный type — ошибка;
 *   - невалидный PGN (chess.js parse fail) — ошибка;
 *   - PGN > 200 КБ — ошибка;
 *   - meta опциональна; невалидные значения внутри meta.
 */

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GameStepPayloadDto } from './step-payload.dto';
import { MAX_GAME_PGN_BYTES } from './game-step.validators';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6';
const INVALID_PGN = '1. nonsense ??';
const TOO_BIG_PGN = 'a'.repeat(MAX_GAME_PGN_BYTES + 1);

async function validatePayload(payload: unknown): Promise<string[]> {
  const instance = plainToInstance(GameStepPayloadDto, payload);
  const errors = await validate(instance as object, {
    whitelist: true,
    forbidUnknownValues: false,
  });
  const out: string[] = [];
  for (const e of errors) {
    for (const msg of Object.values(e.constraints ?? {})) {
      out.push(`${e.property}: ${msg}`);
    }
    // вложенные ошибки в `meta`
    for (const child of e.children ?? []) {
      for (const cm of Object.values(child.constraints ?? {})) {
        out.push(`${e.property}.${child.property}: ${cm}`);
      }
    }
  }
  return out;
}

describe('GameStepPayloadDto (KS-3180)', () => {
  describe('sourceType=pgn', () => {
    it('валидный pgn — без ошибок', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'pgn',
        pgn: VALID_PGN,
      });
      expect(errors).toEqual([]);
    });

    it('pgn + meta — без ошибок', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'pgn',
        pgn: VALID_PGN,
        meta: {
          white: 'Fischer',
          black: 'Spassky',
          result: '1-0',
          date: '1972.07.11',
          event: 'World Championship',
        },
      });
      expect(errors).toEqual([]);
    });

    it('без pgn — XOR ошибка на type', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'pgn',
      });
      expect(errors.some((m) => m.startsWith('type:') && m.includes('requires non-empty pgn'))).toBe(true);
    });

    it('pgn + analysisId — XOR ошибка', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'pgn',
        pgn: VALID_PGN,
        analysisId: VALID_UUID,
      });
      expect(errors.some((m) => m.startsWith('type:') && m.includes('no analysisId'))).toBe(true);
    });

    it('невалидный pgn — ошибка @IsGamePgn', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'pgn',
        pgn: INVALID_PGN,
      });
      expect(errors.some((m) => m.startsWith('pgn:'))).toBe(true);
    });

    it('pgn > 200 КБ — ошибка', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'pgn',
        pgn: TOO_BIG_PGN,
      });
      // @MaxLength или @IsGamePgn сообщат — главное чтобы не пустой массив
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((m) => m.startsWith('pgn:'))).toBe(true);
    });

    it('пустая строка pgn — XOR ошибка (трактуется как «нет»)', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'pgn',
        pgn: '',
      });
      expect(errors.some((m) => m.startsWith('type:') && m.includes('non-empty pgn'))).toBe(true);
    });
  });

  describe('sourceType=workshop_analysis', () => {
    it('analysisId (UUID) без pgn — без ошибок', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'workshop_analysis',
        analysisId: VALID_UUID,
      });
      expect(errors).toEqual([]);
    });

    it('без analysisId — XOR ошибка', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'workshop_analysis',
      });
      expect(errors.some((m) => m.startsWith('type:') && m.includes('requires analysisId'))).toBe(true);
    });

    it('невалидный UUID — ошибка @IsUUID', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'workshop_analysis',
        analysisId: 'not-a-uuid',
      });
      expect(errors.some((m) => m.startsWith('analysisId:'))).toBe(true);
    });

    it('analysisId + pgn (клиент прислал «лишний» pgn, опц.) — допустимо: hydrator перезапишет', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'workshop_analysis',
        analysisId: VALID_UUID,
        pgn: VALID_PGN,
      });
      expect(errors).toEqual([]);
    });

    it('analysisId + слишком большой pgn — отсекается до hydrate', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'workshop_analysis',
        analysisId: VALID_UUID,
        pgn: TOO_BIG_PGN,
      });
      expect(errors.some((m) => m.startsWith('pgn:'))).toBe(true);
    });
  });

  describe('discriminator errors', () => {
    it('неверный type — ошибка @IsIn', async () => {
      const errors = await validatePayload({
        type: 'video',
        sourceType: 'pgn',
        pgn: VALID_PGN,
      });
      expect(errors.some((m) => m.startsWith('type:'))).toBe(true);
    });

    it('неверный sourceType — ошибка @IsIn', async () => {
      const errors = await validatePayload({
        type: 'game',
        sourceType: 'lichess',
        pgn: VALID_PGN,
      });
      expect(errors.some((m) => m.startsWith('sourceType:'))).toBe(true);
    });
  });
});
