// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n/index';
import { AdminHintEditPage } from './AdminHintEditPage';

const API_BASE = 'http://localhost:3001';

function renderPage(path = '/admin/hints/new') {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/hints/new" element={<AdminHintEditPage />} />
          <Route path="/admin/hints/:id" element={<AdminHintEditPage />} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('AdminHintEditPage (KS-4706)', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 200 }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('new — рендерит пустую форму, key редактируется', () => {
    renderPage();
    expect(screen.getByTestId('admin-hint-edit-page')).toBeInTheDocument();
    const key = screen.getByTestId('admin-hint-form-key') as HTMLInputElement;
    expect(key.disabled).toBe(false);
  });

  it('preview — POST /admin/hints/preview-trigger показывает estimate', async () => {
    renderPage();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ estimate: 42, sampled: 100, capped: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('admin-hint-form-preview-btn'));
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('admin-hint-form-preview-result'),
      ).toBeInTheDocument(),
    );
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toBe(`${API_BASE}/admin/hints/preview-trigger`);
  });

  it('невалидный JSON — preview-button disabled, ruleError на blur', async () => {
    renderPage();
    const ta = screen.getByTestId('admin-hint-form-rule') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(ta, { target: { value: '{not-json' } });
      fireEvent.blur(ta);
    });
    expect(screen.getByTestId('admin-hint-form-rule-error')).toBeInTheDocument();
    expect(
      (screen.getByTestId('admin-hint-form-preview-btn') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('submit POST /admin/hints, при 409 показывает keyDuplicate', async () => {
    renderPage();
    // Подставим валидный key/title.
    fireEvent.change(screen.getByTestId('admin-hint-form-key'), {
      target: { value: 'test-key' },
    });
    fireEvent.change(screen.getByTestId('admin-hint-form-ru-title'), {
      target: { value: 'T' },
    });
    fireEvent.change(screen.getByTestId('admin-hint-form-ru-body'), {
      target: { value: 'B' },
    });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'duplicate' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await act(async () => {
      fireEvent.submit(screen.getByTestId('admin-hint-form-submit').closest('form')!);
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('admin-hint-form-key-error'),
      ).toBeInTheDocument(),
    );
  });

  it('submit при 400 кладёт сообщение к DSL-полю', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('admin-hint-form-key'), {
      target: { value: 'k' },
    });
    fireEvent.change(screen.getByTestId('admin-hint-form-ru-title'), {
      target: { value: 'T' },
    });
    fireEvent.change(screen.getByTestId('admin-hint-form-ru-body'), {
      target: { value: 'B' },
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'invalid operator at .all[0]' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await act(async () => {
      fireEvent.submit(screen.getByTestId('admin-hint-form-submit').closest('form')!);
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('admin-hint-form-rule-error'),
      ).toBeInTheDocument(),
    );
  });

  it('KS-4821: CTA-поля редактируются — ctaHref, ctaEvent, ctaLabel(i18n)', async () => {
    renderPage();
    const href = screen.getByTestId('admin-hint-form-cta-href') as HTMLInputElement;
    const event = screen.getByTestId('admin-hint-form-cta-event') as HTMLInputElement;
    const ruLabel = screen.getByTestId(
      'admin-hint-form-ru-cta-label',
    ) as HTMLInputElement;
    expect(href.disabled).toBe(false);
    expect(event.disabled).toBe(false);
    expect(ruLabel.disabled).toBe(false);

    // Отдельные fireEvent — React сбрасывает SyntheticEvent.currentTarget
    // между обработчиками, поэтому в одном `act` подряд несколько change
    // ломает onChange (currentTarget=null во втором setState callback).
    await act(async () => {
      fireEvent.change(href, { target: { value: '/game/abc/review' } });
    });
    await act(async () => {
      fireEvent.change(event, { target: { value: 'open_analysis' } });
    });
    await act(async () => {
      fireEvent.change(ruLabel, { target: { value: 'Открыть анализ' } });
    });
    expect(href.value).toBe('/game/abc/review');
    expect(event.value).toBe('open_analysis');
    expect(ruLabel.value).toBe('Открыть анализ');
  });

  it('edit (по :id) — GET /admin/hints/:id и заполнение формы', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'h-1',
          key: 'hello',
          anchor: 'home-puzzles-tile',
          placement: 'top',
          enabled: true,
          priority: 5,
          targetActorTypes: ['user'],
          titleRu: 'Привет',
          titleEn: 'Hello',
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
          i18n: {
            ru: { title: 'Привет', body: 'Body ru' },
            en: { title: 'Hello', body: 'Body en' },
          },
          cta: null,
          rule: { all: [] },
          acceptedBy: [],
          cooldownSec: 86400,
          ttlSec: 0,
          maxShows: 3,
          deletedAt: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    renderPage('/admin/hints/h-1');
    await waitFor(() =>
      expect(
        (screen.getByTestId('admin-hint-form-key') as HTMLInputElement).value,
      ).toBe('hello'),
    );
    // На edit key disabled (нельзя менять uniq).
    expect(
      (screen.getByTestId('admin-hint-form-key') as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
