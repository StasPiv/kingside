import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RegisterDto } from './register.dto';

describe('RegisterDto', () => {
  const validDto = {
    username: 'testuser',
    email: 'test@example.com',
    password: 'password123',
  };

  function createDto(overrides: Partial<Record<string, any>> = {}): RegisterDto {
    return plainToInstance(RegisterDto, { ...validDto, ...overrides });
  }

  it('should pass with valid data', async () => {
    const errors = await validate(createDto());
    expect(errors).toHaveLength(0);
  });

  describe('username', () => {
    it('should reject username shorter than 3 characters', async () => {
      const errors = await validate(createDto({ username: 'ab' }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should accept username with 3 characters', async () => {
      const errors = await validate(createDto({ username: 'abc' }));
      expect(errors).toHaveLength(0);
    });

    it('should accept username with 20 characters', async () => {
      const errors = await validate(createDto({ username: 'a'.repeat(20) }));
      expect(errors).toHaveLength(0);
    });

    it('should reject username longer than 20 characters', async () => {
      const errors = await validate(createDto({ username: 'a'.repeat(21) }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it.each(['user name', 'user@name', 'user-name', 'user.name'])(
      'should reject username with invalid characters: %s',
      async (username) => {
        const errors = await validate(createDto({ username }));
        expect(errors.length).toBeGreaterThan(0);
      },
    );

    it.each(['user_name', 'User123', 'test_User_1'])(
      'should accept valid username: %s',
      async (username) => {
        const errors = await validate(createDto({ username }));
        expect(errors).toHaveLength(0);
      },
    );

    it('should reject non-string username', async () => {
      const errors = await validate(createDto({ username: 123 }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('email', () => {
    it('should reject invalid email', async () => {
      const errors = await validate(createDto({ email: 'not-an-email' }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should accept valid email', async () => {
      const errors = await validate(createDto({ email: 'user@domain.com' }));
      expect(errors).toHaveLength(0);
    });
  });

  describe('password', () => {
    it('should reject password shorter than 8 characters', async () => {
      const errors = await validate(createDto({ password: '1234567' }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should accept password with 8 characters', async () => {
      const errors = await validate(createDto({ password: '12345678' }));
      expect(errors).toHaveLength(0);
    });

    it('should accept password with 128 characters', async () => {
      const errors = await validate(createDto({ password: 'a'.repeat(128) }));
      expect(errors).toHaveLength(0);
    });

    it('should reject password longer than 128 characters', async () => {
      const errors = await validate(createDto({ password: 'a'.repeat(129) }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should reject non-string password', async () => {
      const errors = await validate(createDto({ password: 12345678 }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
