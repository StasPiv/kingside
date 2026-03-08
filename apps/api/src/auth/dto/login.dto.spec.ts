import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { LoginDto } from './login.dto';

describe('LoginDto', () => {
  const validDto = {
    username: 'testuser',
    password: 'password123',
  };

  function createDto(overrides: Partial<Record<string, any>> = {}): LoginDto {
    return plainToInstance(LoginDto, { ...validDto, ...overrides });
  }

  it('should pass with valid data', async () => {
    const errors = await validate(createDto());
    expect(errors).toHaveLength(0);
  });

  describe('username', () => {
    it('should reject non-string username', async () => {
      const errors = await validate(createDto({ username: 123 }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should accept any string username', async () => {
      const errors = await validate(createDto({ username: 'any_string' }));
      expect(errors).toHaveLength(0);
    });
  });

  describe('password', () => {
    it('should reject non-string password', async () => {
      const errors = await validate(createDto({ password: 123 }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should accept any string password', async () => {
      const errors = await validate(createDto({ password: 'any_string' }));
      expect(errors).toHaveLength(0);
    });
  });
});
