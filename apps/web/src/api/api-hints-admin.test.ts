// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hintsAdminApi } from './api-hints-admin';

const API_BASE = 'http://localhost:3001';

function setOk(payload: unknown) {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('hintsAdminApi (KS-4706)', () => {
  beforeEach(() => {
    // setup.ts уже стабит fetch — добавляем default-ok.
  });
  afterEach(() => vi.restoreAllMocks());

  it('list — собирает query-string из фильтров', async () => {
    setOk([]);
    await hintsAdminApi.list({
      enabled: true,
      anchor: 'landing-signup-button',
      actorType: 'guest',
      search: ' hello ',
      includeDeleted: true,
    });
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toBe(
      `${API_BASE}/admin/hints?enabled=true&anchor=landing-signup-button&actorType=guest&search=hello&includeDeleted=true`,
    );
  });

  it('list — без фильтров: чистый /admin/hints', async () => {
    setOk([]);
    await hintsAdminApi.list();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`${API_BASE}/admin/hints`);
  });

  it('create — POST /admin/hints с телом', async () => {
    setOk({ id: 'h1' });
    await hintsAdminApi.create({
      key: 'test',
      anchor: 'home-puzzles-tile',
      placement: 'bottom',
      rule: { all: [] },
      i18n: { ru: { title: 't', body: 'b' } },
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${API_BASE}/admin/hints`);
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.key).toBe('test');
  });

  it('setStatus — PATCH /admin/hints/:id/status', async () => {
    setOk({ id: 'h1' });
    await hintsAdminApi.setStatus('h1', false);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${API_BASE}/admin/hints/h1/status`);
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      enabled: false,
    });
  });

  it('delete — DELETE /admin/hints/:id', async () => {
    setOk({});
    await hintsAdminApi.delete('h1');
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${API_BASE}/admin/hints/h1`);
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('previewTrigger — POST /admin/hints/preview-trigger', async () => {
    setOk({ estimate: 7, sampled: 100, capped: false });
    const r = await hintsAdminApi.previewTrigger({ all: [] });
    expect(r.estimate).toBe(7);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      `${API_BASE}/admin/hints/preview-trigger`,
    );
  });
});
