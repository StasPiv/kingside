/**
 * Unit-тесты `GameStepHydratorService` (KS-3180 / ADR-072 §7 B1).
 *
 * Покрытие:
 *   - не-game payload — no-op;
 *   - game + sourceType='pgn' — no-op (DTO уже валиден);
 *   - game + sourceType='workshop_analysis' + свой Analysis — snapshot PGN+meta;
 *   - чужой Analysis — 403 ForbiddenException;
 *   - несуществующий Analysis — 404 NotFoundException;
 *   - Analysis без pgn — 400 BadRequestException;
 *   - Analysis с pgn > 200 КБ — 400 BadRequestException;
 *   - userId=null при workshop_analysis — 403;
 *   - сбрасывает meta=, если все поля пустые.
 */

import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { GameStepPayload, StepPayload } from '@kingside/shared';
import { GameStepHydratorService } from './game-step.hydrator';
import { MAX_GAME_PGN_BYTES } from './game-step.validators';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const STRANGER_ID = '33333333-3333-4333-8333-333333333333';
const VALID_PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6';

function makeHydrator(analysis: any | null) {
  const prisma = {
    analysis: {
      findUnique: jest.fn().mockResolvedValue(analysis),
    },
  };
  return new GameStepHydratorService(prisma as any);
}

describe('GameStepHydratorService (KS-3180)', () => {
  it('не-game payload — no-op, тот же объект', async () => {
    const hydrator = makeHydrator(null);
    const payload: StepPayload = {
      type: 'text',
      bodyMarkdown: '# hi',
    };
    const result = await hydrator.hydrate(payload, OWNER_ID);
    expect(result).toBe(payload);
  });

  it('game + sourceType=pgn — no-op', async () => {
    const hydrator = makeHydrator(null);
    const payload: GameStepPayload = {
      type: 'game',
      sourceType: 'pgn',
      pgn: VALID_PGN,
    };
    const result = await hydrator.hydrate(payload, OWNER_ID);
    expect(result).toBe(payload);
  });

  it('workshop_analysis: свой Analysis → snapshot PGN+meta', async () => {
    const hydrator = makeHydrator({
      id: VALID_UUID,
      userId: OWNER_ID,
      pgn: VALID_PGN,
      white: 'Fischer',
      black: 'Spassky',
      result: '1-0',
      pgnDate: '1972.07.11',
      event: 'World Championship',
      site: 'Reykjavik',
      round: '1',
    });
    const payload: GameStepPayload = {
      type: 'game',
      sourceType: 'workshop_analysis',
      analysisId: VALID_UUID,
    };
    const result = (await hydrator.hydrate(payload, OWNER_ID)) as GameStepPayload;
    expect(result.pgn).toBe(VALID_PGN);
    expect(result.meta).toEqual({
      white: 'Fischer',
      black: 'Spassky',
      result: '1-0',
      date: '1972.07.11',
      event: 'World Championship',
      site: 'Reykjavik',
      round: '1',
    });
    // analysisId сохраняется
    expect(result.analysisId).toBe(VALID_UUID);
    expect(result.sourceType).toBe('workshop_analysis');
  });

  it('workshop_analysis: чужой Analysis → 403 ForbiddenException', async () => {
    const hydrator = makeHydrator({
      id: VALID_UUID,
      userId: STRANGER_ID,
      pgn: VALID_PGN,
      white: null,
      black: null,
      result: null,
      pgnDate: null,
      event: null,
      site: null,
      round: null,
    });
    const payload: GameStepPayload = {
      type: 'game',
      sourceType: 'workshop_analysis',
      analysisId: VALID_UUID,
    };
    await expect(hydrator.hydrate(payload, OWNER_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('workshop_analysis: несуществующий Analysis → 404 NotFoundException', async () => {
    const hydrator = makeHydrator(null);
    const payload: GameStepPayload = {
      type: 'game',
      sourceType: 'workshop_analysis',
      analysisId: VALID_UUID,
    };
    await expect(hydrator.hydrate(payload, OWNER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('workshop_analysis: Analysis без PGN → 400 BadRequestException', async () => {
    const hydrator = makeHydrator({
      id: VALID_UUID,
      userId: OWNER_ID,
      pgn: null,
      white: null,
      black: null,
      result: null,
      pgnDate: null,
      event: null,
      site: null,
      round: null,
    });
    const payload: GameStepPayload = {
      type: 'game',
      sourceType: 'workshop_analysis',
      analysisId: VALID_UUID,
    };
    await expect(hydrator.hydrate(payload, OWNER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('workshop_analysis: Analysis с pgn > 200 КБ → 400', async () => {
    const hydrator = makeHydrator({
      id: VALID_UUID,
      userId: OWNER_ID,
      pgn: 'a'.repeat(MAX_GAME_PGN_BYTES + 1),
      white: null,
      black: null,
      result: null,
      pgnDate: null,
      event: null,
      site: null,
      round: null,
    });
    const payload: GameStepPayload = {
      type: 'game',
      sourceType: 'workshop_analysis',
      analysisId: VALID_UUID,
    };
    await expect(hydrator.hydrate(payload, OWNER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('workshop_analysis: Analysis с непарсящимся pgn → 400', async () => {
    const hydrator = makeHydrator({
      id: VALID_UUID,
      userId: OWNER_ID,
      pgn: 'garbage 1. ???',
      white: null,
      black: null,
      result: null,
      pgnDate: null,
      event: null,
      site: null,
      round: null,
    });
    const payload: GameStepPayload = {
      type: 'game',
      sourceType: 'workshop_analysis',
      analysisId: VALID_UUID,
    };
    await expect(hydrator.hydrate(payload, OWNER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('workshop_analysis: userId=null → 403', async () => {
    const hydrator = makeHydrator({
      id: VALID_UUID,
      userId: OWNER_ID,
      pgn: VALID_PGN,
      white: null,
      black: null,
      result: null,
      pgnDate: null,
      event: null,
      site: null,
      round: null,
    });
    const payload: GameStepPayload = {
      type: 'game',
      sourceType: 'workshop_analysis',
      analysisId: VALID_UUID,
    };
    await expect(hydrator.hydrate(payload, null)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('workshop_analysis: пустые meta-поля → meta отсутствует в snapshot', async () => {
    const hydrator = makeHydrator({
      id: VALID_UUID,
      userId: OWNER_ID,
      pgn: VALID_PGN,
      white: null,
      black: null,
      result: null,
      pgnDate: null,
      event: null,
      site: null,
      round: null,
    });
    const payload: GameStepPayload = {
      type: 'game',
      sourceType: 'workshop_analysis',
      analysisId: VALID_UUID,
    };
    const result = (await hydrator.hydrate(payload, OWNER_ID)) as GameStepPayload;
    expect(result.meta).toBeUndefined();
    expect(result.pgn).toBe(VALID_PGN);
  });

  it('workshop_analysis: analysisId отсутствует → 400 (защита от вызова в обход DTO)', async () => {
    const hydrator = makeHydrator(null);
    const payload = {
      type: 'game',
      sourceType: 'workshop_analysis',
    } as GameStepPayload;
    await expect(hydrator.hydrate(payload, OWNER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
