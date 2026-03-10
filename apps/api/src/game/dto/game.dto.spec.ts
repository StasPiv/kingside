import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateGameWithBotDto } from './game.dto';

describe('CreateGameWithBotDto', () => {
  const validDto = {
    color: 'white',
    botLevel: 3,
    timeControl: 'blitz',
  };

  function createDto(overrides: Partial<Record<string, any>> = {}): CreateGameWithBotDto {
    return plainToInstance(CreateGameWithBotDto, { ...validDto, ...overrides });
  }

  it('should pass with valid data', async () => {
    const errors = await validate(createDto());
    expect(errors).toHaveLength(0);
  });

  describe('color', () => {
    it.each(['white', 'black', 'random'])('should accept color=%s', async (color) => {
      const errors = await validate(createDto({ color }));
      expect(errors).toHaveLength(0);
    });

    it('should reject invalid color', async () => {
      const errors = await validate(createDto({ color: 'red' }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('botLevel', () => {
    it.each([1, 5, 10, 15, 20])('should accept level %i', async (level) => {
      const errors = await validate(createDto({ botLevel: level }));
      expect(errors).toHaveLength(0);
    });

    it('should reject level 0', async () => {
      const errors = await validate(createDto({ botLevel: 0 }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should reject level 21 (DTO max is 20)', async () => {
      const errors = await validate(createDto({ botLevel: 21 }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should reject negative level', async () => {
      const errors = await validate(createDto({ botLevel: -1 }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should reject non-integer level', async () => {
      const errors = await validate(createDto({ botLevel: 3.5 }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('timeControl', () => {
    it.each(['bullet', 'blitz', 'rapid', 'classical'])(
      'should accept timeControl=%s',
      async (tc) => {
        const errors = await validate(createDto({ timeControl: tc }));
        expect(errors).toHaveLength(0);
      },
    );

    it('should reject invalid time control', async () => {
      const errors = await validate(createDto({ timeControl: 'hyper' }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
