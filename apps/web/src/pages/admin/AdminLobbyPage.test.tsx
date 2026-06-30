// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n/index';
import { AdminLobbyPage } from './AdminLobbyPage';

function renderPage() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/admin']}>
        <AdminLobbyPage />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('AdminLobbyPage (KS-4829)', () => {
  it('рендерится контейнер лобби и список разделов', () => {
    renderPage();
    expect(screen.getByTestId('admin-lobby-page')).toBeInTheDocument();
    const list = screen.getByTestId('admin-lobby-list');
    expect(list.querySelectorAll('li')).toHaveLength(4);
  });

  it('содержит ссылку на feature-flags', () => {
    renderPage();
    const link = screen.getByTestId('admin-lobby-link-feature-flags');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/admin/feature-flags');
  });

  it('содержит ссылку на подсказки (/admin/hints)', () => {
    renderPage();
    const link = screen.getByTestId('admin-lobby-link-hints');
    expect(link.getAttribute('href')).toBe('/admin/hints');
  });

  it('содержит ссылки на блог: посты и авторы', () => {
    renderPage();
    expect(
      screen.getByTestId('admin-lobby-link-blog-posts').getAttribute('href'),
    ).toBe('/admin/blog/posts');
    expect(
      screen.getByTestId('admin-lobby-link-blog-authors').getAttribute('href'),
    ).toBe('/admin/blog/authors');
  });

  it('у каждой карточки есть короткое описание', () => {
    renderPage();
    const list = screen.getByTestId('admin-lobby-list');
    list.querySelectorAll('li').forEach((li) => {
      const desc = li.querySelector('.admin-lobby__description');
      expect(desc?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    });
  });
});
