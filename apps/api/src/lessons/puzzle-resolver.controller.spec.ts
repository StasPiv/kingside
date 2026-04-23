import { PuzzleResolverController } from './puzzle-resolver.controller';
import { LessonPuzzleResolverService } from './puzzle-resolver.service';
import type { PuzzleStepPayloadDto } from './dto/step-payload.dto';

describe('PuzzleResolverController (KS-1777)', () => {
  let controller: PuzzleResolverController;
  let resolver: jest.Mocked<LessonPuzzleResolverService>;

  beforeEach(() => {
    resolver = { resolve: jest.fn() } as unknown as jest.Mocked<LessonPuzzleResolverService>;
    controller = new PuzzleResolverController(resolver);
  });

  it('POST /lessons/puzzle-step/resolve → resolver.resolve(payload) для filter-mode', async () => {
    const puzzles = [{ id: 'p1', rating: 1100 }, { id: 'p2', rating: 1150 }];
    resolver.resolve.mockResolvedValue(puzzles as any);

    const payload: PuzzleStepPayloadDto = {
      type: 'puzzle',
      selection: {
        mode: 'filter',
        themes: ['fork'] as any,
        ratingMin: 1000,
        ratingMax: 1200,
        limit: 5,
      } as any,
      minSolved: 3,
    };

    const res = await controller.resolve(payload);
    expect(resolver.resolve).toHaveBeenCalledWith(payload);
    expect(res).toEqual(puzzles);
  });

  it('POST /lessons/puzzle-step/resolve → resolver.resolve(payload) для ids-mode', async () => {
    resolver.resolve.mockResolvedValue([{ id: 'a' }] as any);

    const payload: PuzzleStepPayloadDto = {
      type: 'puzzle',
      selection: { mode: 'ids', puzzleIds: ['a', 'b', 'c'] } as any,
    };

    await controller.resolve(payload);
    expect(resolver.resolve).toHaveBeenCalledWith(payload);
  });
});
