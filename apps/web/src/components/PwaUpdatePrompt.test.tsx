import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../test/test-utils';
import { waitFor, act } from '@testing-library/react';

/**
 * KS-2374: тесты для PwaUpdatePrompt. В jsdom нет реального SW —
 * мокаем `navigator.serviceWorker` и `import.meta.env.DEV` через
 * vi.stubEnv. Промпт появляется только когда:
 *   1. import.meta.env.DEV = false (production-режим);
 *   2. зарегистрирован SW + есть активный controller (signal apgrade);
 *   3. новый installer переходит в state='installed'.
 */

interface MockWorker {
  state: 'installing' | 'installed' | 'activating' | 'activated';
  listeners: Array<(this: MockWorker) => void>;
  addEventListener: (event: string, fn: (this: MockWorker) => void) => void;
  removeEventListener: (event: string, fn: () => void) => void;
}

interface MockRegistration {
  installing: MockWorker | null;
  waiting: MockWorker | null;
  listeners: Record<string, Array<() => void>>;
  addEventListener: (event: string, fn: () => void) => void;
  removeEventListener: (event: string, fn: () => void) => void;
  update: () => Promise<void>;
}

function makeWorker(): MockWorker {
  const w: MockWorker = {
    state: 'installing',
    listeners: [],
    addEventListener(event, fn) {
      if (event === 'statechange') this.listeners.push(fn);
    },
    removeEventListener(event, fn) {
      if (event === 'statechange') {
        this.listeners = this.listeners.filter((l) => l !== fn);
      }
    },
  };
  return w;
}

function fireStateChange(worker: MockWorker, state: MockWorker['state']) {
  worker.state = state;
  for (const fn of worker.listeners) fn.call(worker);
}

function makeRegistration(): MockRegistration {
  const r: MockRegistration = {
    installing: null,
    waiting: null,
    listeners: {},
    addEventListener(event, fn) {
      (r.listeners[event] = r.listeners[event] ?? []).push(fn);
    },
    removeEventListener(event, fn) {
      r.listeners[event] = (r.listeners[event] ?? []).filter((l) => l !== fn);
    },
    update: vi.fn(async () => undefined),
  };
  return r;
}

const originalNavigator = globalThis.navigator;

let registerMock: ReturnType<typeof vi.fn>;
let registration: MockRegistration;
let controllerObj: object | null;

beforeEach(() => {
  registration = makeRegistration();
  controllerObj = { /* mock active SW */ };
  registerMock = vi.fn().mockResolvedValue(registration);
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      serviceWorker: {
        register: registerMock,
        get controller() {
          return controllerObj;
        },
      },
    },
    writable: true,
    configurable: true,
  });
  // PROD-режим — иначе компонент сразу выходит.
  vi.stubEnv('DEV', false);
});

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    writable: true,
    configurable: true,
  });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

import { PwaUpdatePrompt } from './PwaUpdatePrompt';

describe('<PwaUpdatePrompt> KS-2374', () => {
  it('PROD + регистрация без upgrade события → плашка не показана', async () => {
    renderWithProviders(<PwaUpdatePrompt />);
    await waitFor(() => expect(registerMock).toHaveBeenCalledWith('/sw.js', { scope: '/' }));
    expect(screen.queryByTestId('pwa-update-prompt')).not.toBeInTheDocument();
  });

  it('updatefound → installer → installed + есть controller → плашка показана', async () => {
    renderWithProviders(<PwaUpdatePrompt />);
    await waitFor(() => expect(registerMock).toHaveBeenCalled());
    // Симулируем апгрейд: installing-worker появляется и достигает 'installed'.
    const installer = makeWorker();
    registration.installing = installer;
    act(() => {
      for (const fn of registration.listeners['updatefound'] ?? []) fn();
    });
    act(() => {
      fireStateChange(installer, 'installed');
    });
    await waitFor(() =>
      expect(screen.getByTestId('pwa-update-prompt')).toBeInTheDocument(),
    );
  });

  it('первая установка (controller=null) → плашка НЕ показана даже на installed', async () => {
    controllerObj = null;
    renderWithProviders(<PwaUpdatePrompt />);
    await waitFor(() => expect(registerMock).toHaveBeenCalled());
    const installer = makeWorker();
    registration.installing = installer;
    act(() => {
      for (const fn of registration.listeners['updatefound'] ?? []) fn();
    });
    act(() => {
      fireStateChange(installer, 'installed');
    });
    expect(screen.queryByTestId('pwa-update-prompt')).not.toBeInTheDocument();
  });

  it('waiting SW при регистрации (предыдущий deploy не дошёл) → плашка показана', async () => {
    registration.waiting = makeWorker();
    renderWithProviders(<PwaUpdatePrompt />);
    await waitFor(() =>
      expect(screen.getByTestId('pwa-update-prompt')).toBeInTheDocument(),
    );
  });

  it('«Reload» → window.location.reload вызван', async () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: reloadMock },
    });
    registration.waiting = makeWorker();
    renderWithProviders(<PwaUpdatePrompt />);
    await waitFor(() =>
      expect(screen.getByTestId('pwa-update-prompt')).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId('pwa-update-prompt-reload'));
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('«Later» → плашка скрывается, reload не вызывается', async () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: reloadMock },
    });
    registration.waiting = makeWorker();
    renderWithProviders(<PwaUpdatePrompt />);
    await waitFor(() =>
      expect(screen.getByTestId('pwa-update-prompt')).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId('pwa-update-prompt-dismiss'));
    expect(screen.queryByTestId('pwa-update-prompt')).not.toBeInTheDocument();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('DEV-режим → SW не регистрируется (main.tsx сам отписывает)', async () => {
    vi.stubEnv('DEV', true);
    renderWithProviders(<PwaUpdatePrompt />);
    // Подождём чуть-чуть, чтобы убедиться что register НЕ вызвался.
    await new Promise((r) => setTimeout(r, 30));
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('navigator без serviceWorker → no-op без падения', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      writable: true,
      configurable: true,
    });
    expect(() => renderWithProviders(<PwaUpdatePrompt />)).not.toThrow();
  });
});
