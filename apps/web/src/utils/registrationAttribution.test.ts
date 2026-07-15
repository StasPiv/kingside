import { describe, it, expect, beforeEach, vi } from 'vitest';

const trackEvent = vi.fn();
vi.mock('./analytics', () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}));

import {
  captureFirstTouchAttribution,
  markLoginStart,
  getRegistrationSource,
  emitRegistrationEvent,
  clearRegistrationSource,
} from './registrationAttribution';

function setLocation(pathname: string, search: string) {
  window.history.replaceState({}, '', pathname + search);
}

function setReferrer(value: string) {
  Object.defineProperty(document, 'referrer', {
    configurable: true,
    value,
  });
}

describe('registrationAttribution', () => {
  beforeEach(() => {
    sessionStorage.clear();
    trackEvent.mockClear();
    setReferrer('');
    setLocation('/', '');
  });

  it('captures first-touch landing, referrer and utm once', () => {
    setReferrer('https://reddit.com/r/chess');
    setLocation('/blog/game-review', '?utm_source=reddit&utm_medium=post');
    captureFirstTouchAttribution();

    // Внутренняя навигация не должна перетереть исходный источник.
    setReferrer('https://oauth.telegram.org');
    setLocation('/login', '');
    captureFirstTouchAttribution();

    const src = getRegistrationSource();
    expect(src.landingPage).toBe('/blog/game-review?utm_source=reddit&utm_medium=post');
    expect(src.referrer).toBe('https://reddit.com/r/chess');
    expect(src.utm).toEqual({ utm_source: 'reddit', utm_medium: 'post' });
  });

  it('marks login start with provider and current page', () => {
    setLocation('/features', '');
    markLoginStart('google');
    const src = getRegistrationSource();
    expect(src.provider).toBe('google');
    expect(src.loginPage).toBe('/features');
  });

  it('source survives a simulated OAuth redirect (sessionStorage retained)', () => {
    setReferrer('https://t.me/kingside_site');
    setLocation('/puzzles', '?utm_source=telegram');
    captureFirstTouchAttribution();
    markLoginStart('telegram');

    // Редирект на провайдера и обратно не трогает sessionStorage.
    setReferrer('https://oauth.telegram.org');
    setLocation('/oauth/callback', '');

    const src = getRegistrationSource();
    expect(src.referrer).toBe('https://t.me/kingside_site');
    expect(src.utm).toEqual({ utm_source: 'telegram' });
    expect(src.provider).toBe('telegram');
  });

  it('emits sign_up with the original source and clears storage', () => {
    setReferrer('https://reddit.com/r/chess');
    setLocation('/blog/x', '?utm_source=reddit&utm_campaign=organic');
    captureFirstTouchAttribution();
    markLoginStart('google');

    emitRegistrationEvent();

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('sign_up', expect.objectContaining({
      method: 'google',
      source_page: '/blog/x?utm_source=reddit&utm_campaign=organic',
      referrer: 'https://reddit.com/r/chess',
      utm_source: 'reddit',
      utm_campaign: 'organic',
    }));
    // После отправки данные очищены — повторно не всплывут.
    const src = getRegistrationSource();
    expect(src.referrer).toBeUndefined();
    expect(src.provider).toBeUndefined();
  });

  it('emitRegistrationEvent honours explicit method override', () => {
    markLoginStart('google');
    emitRegistrationEvent('telegram');
    expect(trackEvent).toHaveBeenCalledWith('sign_up', expect.objectContaining({
      method: 'telegram',
    }));
  });

  it('clearRegistrationSource removes stored data', () => {
    captureFirstTouchAttribution();
    markLoginStart('facebook');
    clearRegistrationSource();
    const src = getRegistrationSource();
    expect(src.provider).toBeUndefined();
    expect(src.landingPage).toBeUndefined();
  });
});
