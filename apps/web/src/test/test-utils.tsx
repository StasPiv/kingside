import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n, { type i18n as I18nInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { ReactElement, ReactNode } from 'react';

import en from '../i18n/locales/en/translation.json';
import { BoardSettingsProvider } from '../context/BoardSettingsContext';

const testI18n: I18nInstance = i18n.createInstance();
testI18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

type WrapperOptions = {
  route?: string;
};

function createWrapper({ route = '/' }: WrapperOptions = {}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nextProvider i18n={testI18n}>
        <BoardSettingsProvider>
          <MemoryRouter initialEntries={[route]}>
            {children}
          </MemoryRouter>
        </BoardSettingsProvider>
      </I18nextProvider>
    );
  };
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'> & WrapperOptions,
) {
  const { route, ...renderOptions } = options ?? {};
  return render(ui, {
    wrapper: createWrapper({ route }),
    ...renderOptions,
  });
}

export { testI18n };
export { default as userEvent } from '@testing-library/user-event';
export { screen, waitFor, within } from '@testing-library/react';
