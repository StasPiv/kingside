/**
 * Unit-тесты DTO `PositionStepPayloadDto` (KS-1807 / L-23).
 *
 * Покрытие по Gherkin:
 *   - валидный payload;
 *   - невалидный FEN (chess.js отказывается грузить);
 *   - пустой `expectedMoves`;
 *   - UCI-ход нелегален на позиции;
 *   - UCI с промоушеном (`e7e8q`) — легален на подходящей позиции.
 */

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PositionStepPayloadDto } from './step-payload.dto';

async function validatePayload(payload: unknown): Promise<string[]> {
  const instance = plainToInstance(PositionStepPayloadDto, payload);
  const errors = await validate(instance as object, {
    whitelist: true,
    forbidUnknownValues: false,
  });
  // Склеиваем все сообщения — тесты ищут конкретные подстроки.
  const out: string[] = [];
  for (const e of errors) {
    for (const msg of Object.values(e.constraints ?? {})) out.push(`${e.property}: ${msg}`);
  }
  return out;
}

describe('PositionStepPayloadDto', () => {
  it('валидный payload — нет ошибок', async () => {
    const errors = await validatePayload({
      type: 'position',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      expectedMoves: ['e2e4'],
      orientation: 'white',
    });
    expect(errors).toEqual([]);
  });

  it('невалидный FEN — ошибка на поле fen', async () => {
    const errors = await validatePayload({
      type: 'position',
      fen: 'not-a-fen',
      expectedMoves: ['e2e4'],
    });
    expect(errors.some((m) => m.startsWith('fen:') && m.includes('valid FEN'))).toBe(true);
  });

  // KS-1983: expectedMoves теперь опционально. Пустой массив /
  // отсутствие поля = read-only показ позиции.
  it('пустой expectedMoves — валидно (read-only позиция, KS-1983)', async () => {
    const errors = await validatePayload({
      type: 'position',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      expectedMoves: [],
    });
    expect(errors).toEqual([]);
  });

  it('expectedMoves отсутствует — валидно (KS-1983)', async () => {
    const errors = await validatePayload({
      type: 'position',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    });
    expect(errors).toEqual([]);
  });

  it('UCI нелегален на данной позиции — ошибка', async () => {
    const errors = await validatePayload({
      type: 'position',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      // e2e5 — пешка не ходит через две клетки со второй на пятую.
      expectedMoves: ['e2e5'],
    });
    expect(errors.some((m) => m.startsWith('expectedMoves:') && m.includes('legal'))).toBe(true);
  });

  it('промоушен e7e8q легален, когда поле e8 пусто', async () => {
    const errors = await validatePayload({
      type: 'position',
      // Белая пешка на e7, чёрный король на h8, белый король на e1. Ход
      // e7e8q — легальный промоушен в ферзя.
      fen: '7k/4P3/8/8/8/8/8/4K3 w - - 0 1',
      expectedMoves: ['e7e8q'],
    });
    expect(errors).toEqual([]);
  });

  it('неверный type — ошибка', async () => {
    const errors = await validatePayload({
      type: 'text',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      expectedMoves: ['e2e4'],
    });
    expect(errors.some((m) => m.startsWith('type:'))).toBe(true);
  });

  it('orientation принимает только white|black', async () => {
    const errors = await validatePayload({
      type: 'position',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      expectedMoves: ['e2e4'],
      orientation: 'sideways',
    });
    expect(errors.some((m) => m.startsWith('orientation:'))).toBe(true);
  });

  it('при битом FEN массив expectedMoves тоже помечается невалидным', async () => {
    const errors = await validatePayload({
      type: 'position',
      fen: 'garbage',
      expectedMoves: ['e2e4'],
    });
    // Ожидаем ошибки и на fen, и на expectedMoves (FEN невалиден →
    // легальность ходов непроверяема, но шаг не должен быть принят).
    expect(errors.some((m) => m.startsWith('fen:'))).toBe(true);
    expect(errors.some((m) => m.startsWith('expectedMoves:'))).toBe(true);
  });
});
