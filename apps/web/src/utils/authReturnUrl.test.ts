import { describe, expect, it, beforeEach } from 'vitest';
import {
  consumeAuthReturnUrl,
  peekAuthReturnUrl,
  setAuthReturnUrl,
} from './authReturnUrl';

beforeEach(() => {
  sessionStorage.clear();
});

describe('authReturnUrl (KS-2110)', () => {
  it('set/peek/consume — happy path', () => {
    setAuthReturnUrl('/lessons');
    expect(peekAuthReturnUrl()).toBe('/lessons');
    expect(consumeAuthReturnUrl()).toBe('/lessons');
    // После consume значение удалено.
    expect(peekAuthReturnUrl()).toBeNull();
    expect(consumeAuthReturnUrl()).toBeNull();
  });

  it('сохраняет path с query', () => {
    setAuthReturnUrl('/lessons?course=intro');
    expect(consumeAuthReturnUrl()).toBe('/lessons?course=intro');
  });

  it('игнорирует /login, /register, /oauth/callback (защита от закольцовки)', () => {
    setAuthReturnUrl('/login');
    expect(consumeAuthReturnUrl()).toBeNull();

    setAuthReturnUrl('/login?return=foo');
    expect(consumeAuthReturnUrl()).toBeNull();

    setAuthReturnUrl('/register');
    expect(consumeAuthReturnUrl()).toBeNull();

    setAuthReturnUrl('/oauth/callback');
    expect(consumeAuthReturnUrl()).toBeNull();

    setAuthReturnUrl('/oauth/callback?accessToken=x');
    expect(consumeAuthReturnUrl()).toBeNull();
  });

  it('игнорирует относительные пути и пустые значения', () => {
    setAuthReturnUrl('');
    expect(consumeAuthReturnUrl()).toBeNull();

    setAuthReturnUrl('relative/path');
    expect(consumeAuthReturnUrl()).toBeNull();

    setAuthReturnUrl('https://evil.example.com');
    expect(consumeAuthReturnUrl()).toBeNull();
  });

  it('peek не удаляет значение', () => {
    setAuthReturnUrl('/lessons');
    expect(peekAuthReturnUrl()).toBe('/lessons');
    expect(peekAuthReturnUrl()).toBe('/lessons');
    expect(consumeAuthReturnUrl()).toBe('/lessons');
  });
});
