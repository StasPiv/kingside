import { PuzzleRatingService } from './puzzle-rating.service';

describe('PuzzleRatingService', () => {
  let service: PuzzleRatingService;

  beforeEach(() => {
    service = new PuzzleRatingService();
  });

  it('should increase rating when solving a harder puzzle', () => {
    const result = service.calculateNewRating(1500, 1600, true);
    expect(result).toBeGreaterThan(1500);
  });

  it('should decrease rating when failing an easier puzzle', () => {
    const result = service.calculateNewRating(1500, 1400, false);
    expect(result).toBeLessThan(1500);
  });

  it('should increase rating less when solving an easier puzzle', () => {
    const hardSolve = service.calculateNewRating(1500, 1700, true);
    const easySolve = service.calculateNewRating(1500, 1300, true);
    expect(hardSolve - 1500).toBeGreaterThan(easySolve - 1500);
  });

  it('should not go below 100', () => {
    const result = service.calculateNewRating(100, 2000, false);
    expect(result).toBeGreaterThanOrEqual(100);
  });

  it('should give ~16 points for equal rating solved', () => {
    const result = service.calculateNewRating(1500, 1500, true);
    expect(result).toBe(1516);
  });

  it('should lose ~16 points for equal rating failed', () => {
    const result = service.calculateNewRating(1500, 1500, false);
    expect(result).toBe(1484);
  });
});
