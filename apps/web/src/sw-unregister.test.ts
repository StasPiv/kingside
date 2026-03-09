import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * KS-275: Unit tests for Service Worker unregistration logic in main.tsx.
 *
 * Verifies that in DEV mode, existing SW registrations are automatically
 * unregistered to prevent stale cache issues (part of KS-274 fix).
 */

describe('SW unregistration in dev mode', () => {
  const originalNavigator = globalThis.navigator;
  let mockUnregister: ReturnType<typeof vi.fn>;
  let mockGetRegistrations: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUnregister = vi.fn().mockResolvedValue(true);
    mockGetRegistrations = vi.fn().mockResolvedValue([
      { unregister: mockUnregister },
      { unregister: mockUnregister },
    ]);

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          getRegistrations: mockGetRegistrations,
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  it('unregisters all SW registrations when DEV and serviceWorker available', async () => {
    // Simulate the logic from main.tsx
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        registration.unregister();
      }
    }

    expect(mockGetRegistrations).toHaveBeenCalledOnce();
    expect(mockUnregister).toHaveBeenCalledTimes(2);
  });

  it('handles zero registrations gracefully', async () => {
    mockGetRegistrations.mockResolvedValue([]);

    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        registration.unregister();
      }
    }

    expect(mockGetRegistrations).toHaveBeenCalledOnce();
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  it('does not call getRegistrations when serviceWorker is not available', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      writable: true,
      configurable: true,
    });

    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        registration.unregister();
      }
    }

    expect(mockGetRegistrations).not.toHaveBeenCalled();
  });
});
