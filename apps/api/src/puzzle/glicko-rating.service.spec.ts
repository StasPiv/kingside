import { GlickoRatingService } from './glicko-rating.service';

describe('GlickoRatingService', () => {
  let service: GlickoRatingService;

  beforeEach(() => {
    service = new GlickoRatingService();
  });

  describe('updatePuzzleRating', () => {
    it('new puzzle (RD=350) changes fast when solved', () => {
      const result = service.updatePuzzleRating(1500, 350, 1200, true);
      // Puzzle "lost" — rating should drop significantly
      expect(result.newRating).toBeLessThan(1400);
      expect(result.newRD).toBeLessThan(350);
    });

    it('new puzzle (RD=350) changes fast when failed', () => {
      const result = service.updatePuzzleRating(1500, 350, 1200, false);
      // Puzzle "won" against weaker player — rating should increase
      expect(result.newRating).toBeGreaterThan(1500);
    });

    it('stable puzzle (RD=50) changes less than new puzzle', () => {
      const stableResult = service.updatePuzzleRating(1500, 50, 1200, true);
      const newResult = service.updatePuzzleRating(1500, 350, 1200, true);
      // Stable puzzle changes less than new puzzle
      const stableDelta = Math.abs(1500 - stableResult.newRating);
      const newDelta = Math.abs(1500 - newResult.newRating);
      expect(stableDelta).toBeLessThan(newDelta);
      expect(stableResult.newRating).toBeLessThan(1500);
    });

    it('stable puzzle (RD=50) changes slowly when failed', () => {
      const result = service.updatePuzzleRating(1500, 50, 1200, false);
      expect(result.newRating).toBeGreaterThan(1500);
      expect(result.newRating).toBeLessThan(1520);
    });

    it('RD never goes below 30', () => {
      // Many games should reduce RD but not below 30
      let rd = 350;
      let rating = 1500;
      for (let i = 0; i < 100; i++) {
        const result = service.updatePuzzleRating(rating, rd, 1500, i % 2 === 0);
        rating = result.newRating;
        rd = result.newRD;
      }
      expect(rd).toBeGreaterThanOrEqual(30);
    });
  });

  describe('updatePlayerRating', () => {
    it('player gains rating when solving harder puzzle', () => {
      const newRating = service.updatePlayerRating(1200, 1500, true);
      expect(newRating).toBeGreaterThan(1200);
      // Should gain more than 16 (expected < 0.5)
      expect(newRating - 1200).toBeGreaterThan(16);
    });

    it('player loses rating when failing easier puzzle', () => {
      const newRating = service.updatePlayerRating(1500, 1200, false);
      expect(newRating).toBeLessThan(1500);
      // Should lose more than 16
      expect(1500 - newRating).toBeGreaterThan(16);
    });

    it('equal ratings: win gives ~16, lose gives ~16', () => {
      const win = service.updatePlayerRating(1500, 1500, true);
      const lose = service.updatePlayerRating(1500, 1500, false);
      expect(win - 1500).toBe(16);
      expect(1500 - lose).toBe(16);
    });
  });

  // KS-2311 (methodology §10.5).
  describe('updateUserRatingContinuous', () => {
    it('score=1.0 эквивалентно updateUserRating(solved=true)', () => {
      const binary = service.updateUserRating(1500, 200, 1500, 50, true);
      const cont = service.updateUserRatingContinuous(
        1500,
        200,
        1500,
        50,
        1.0,
      );
      expect(cont).toEqual(binary);
    });

    it('score=0.0 эквивалентно updateUserRating(solved=false)', () => {
      const binary = service.updateUserRating(1500, 200, 1500, 50, false);
      const cont = service.updateUserRatingContinuous(
        1500,
        200,
        1500,
        50,
        0.0,
      );
      expect(cont).toEqual(binary);
    });

    it('score=0.5 при равных рейтингах → ~ no change (ничья)', () => {
      const r = service.updateUserRatingContinuous(
        1500,
        100,
        1500,
        50,
        0.5,
      );
      expect(Math.abs(r.newRating - 1500)).toBeLessThanOrEqual(1);
    });

    it('score=0.7 (continuous IoU) против equal-rating → положительный', () => {
      const r = service.updateUserRatingContinuous(
        1500,
        200,
        1500,
        50,
        0.7,
      );
      expect(r.newRating).toBeGreaterThan(1500);
    });

    it('score < 0.5 против equal-rating → отрицательный', () => {
      const r = service.updateUserRatingContinuous(
        1500,
        200,
        1500,
        50,
        0.3,
      );
      expect(r.newRating).toBeLessThan(1500);
    });

    it('score вне [0,1] клампится', () => {
      const high = service.updateUserRatingContinuous(1500, 200, 1500, 50, 5);
      const equiv = service.updateUserRatingContinuous(1500, 200, 1500, 50, 1);
      expect(high).toEqual(equiv);
      const low = service.updateUserRatingContinuous(1500, 200, 1500, 50, -5);
      const equivLow = service.updateUserRatingContinuous(
        1500,
        200,
        1500,
        50,
        0,
      );
      expect(low).toEqual(equivLow);
    });
  });
});
