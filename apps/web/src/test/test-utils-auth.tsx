/**
 * KS-4179: расширенный wrapper для тестов, чьи компоненты после
 * гостевых правок KS-4124/4131/4140/4142 стали требовать
 * `useAuth`/`useRequireAuth`. Вынесен в отдельный модуль, чтобы базовый
 * `test-utils.tsx` НЕ импортировал `AuthContext`/`RequireAuthProvider`
 * на уровне модуля — иначе любой тест с `vi.mock('../context/AuthContext')`
 * (а таких в проекте под полсотни) ломает само окружение test-utils
 * (mock не отдаёт `AuthContext` → undefined → ReferenceError).
 *
 * Использовать как `import { renderWithAuth } from '../test/test-utils-auth'`.
 */
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { User } from '@kingside/shared';

import { BoardSettingsProvider } from '../context/BoardSettingsContext';
import { ThemeProvider } from '../context/ThemeContext';
import { AuthContext } from '../context/AuthContext';
import { RequireAuthProvider } from '../context/RequireAuthContext';
import { testI18n } from './test-utils';

type AuthWrapperOptions = {
  route?: string;
  /**
   * Подсунуть user в AuthContext. По умолчанию — null (гость).
   * Используется тестами, чьим компонентам нужен авторизованный
   * сценарий без отдельного `vi.mock('../context/AuthContext')`.
   */
  user?: Partial<User> | null;
};

function makeAuthValue(user: Partial<User> | null) {
  // Лёгкий «фейковый» контекст auth — без fetchMe, без localStorage,
  // чтобы тесты, не работающие с auth-сетью, не тянули реальный
  // AuthProvider (он делает `api.get('/auth/me')` и иначе ломает
  // 100+ smoke-тестов, не оборачиваемых в нужные mock'и).
  return {
    user: (user as User | null) ?? null,
    token: user ? 'test-token' : null,
    loading: false,
    login: vi.fn(async () => {}),
    register: vi.fn(async () => {}),
    loginWithTokens: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(async () => {}),
  };
}

function createAuthWrapper({ route = '/', user = null }: AuthWrapperOptions = {}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nextProvider i18n={testI18n}>
        <ThemeProvider initialTheme="dark">
          <BoardSettingsProvider>
            <MemoryRouter initialEntries={[route]}>
              <AuthContext.Provider value={makeAuthValue(user)}>
                <RequireAuthProvider>
                  {children}
                </RequireAuthProvider>
              </AuthContext.Provider>
            </MemoryRouter>
          </BoardSettingsProvider>
        </ThemeProvider>
      </I18nextProvider>
    );
  };
}

/**
 * Рендер с полным набором auth-провайдеров (AuthContext +
 * RequireAuthProvider). По умолчанию user=null (гость); передайте
 * `{ user: { id, username, ... } }` для авторизованного сценария.
 */
export function renderWithAuth(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'> & AuthWrapperOptions,
) {
  const { route, user, ...renderOptions } = options ?? {};
  return render(ui, {
    wrapper: createAuthWrapper({ route, user }),
    ...renderOptions,
  });
}

export { screen, waitFor, within } from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';
