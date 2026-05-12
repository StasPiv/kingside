import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * KS-2824 (KS-2815 §B.4): smoke-тесты `studiesApi`. Дёргаем все методы,
 * проверяем что они формируют корректный path и method, передают тело.
 * Реальный HTTP-клиент `api` мокаем.
 */

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();
const apiDeleteMock = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (path: string) => apiGetMock(path),
    post: (path: string, body: unknown) => apiPostMock(path, body),
    patch: (path: string, body: unknown) => apiPatchMock(path, body),
    delete: (path: string) => apiDeleteMock(path),
    put: vi.fn(),
  },
}));

import { studiesApi } from './studiesApi';

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPatchMock.mockReset();
  apiDeleteMock.mockReset();
  apiGetMock.mockResolvedValue({ data: [] });
  apiPostMock.mockResolvedValue({});
  apiPatchMock.mockResolvedValue({});
  apiDeleteMock.mockResolvedValue(undefined);
});

describe('studiesApi', () => {
  // --- Listing ---

  it('list({mine: true}) → GET /studies?mine=1', async () => {
    await studiesApi.list({ mine: true });
    expect(apiGetMock).toHaveBeenCalledWith('/studies?mine=1');
  });

  it('list() без opts → GET /studies?mine=0', async () => {
    await studiesApi.list();
    expect(apiGetMock).toHaveBeenCalledWith('/studies?mine=0');
  });

  it('listPublic() → GET /studies/public', async () => {
    await studiesApi.listPublic();
    expect(apiGetMock).toHaveBeenCalledWith('/studies/public');
  });

  it('getBySlug encodes slug', async () => {
    await studiesApi.getBySlug('my study/with slash');
    expect(apiGetMock).toHaveBeenCalledWith(
      '/studies/my%20study%2Fwith%20slash',
    );
  });

  // --- Study CRUD ---

  it('create → POST /studies', async () => {
    await studiesApi.create({ name: 'Demo', isPublic: false });
    expect(apiPostMock).toHaveBeenCalledWith('/studies', {
      name: 'Demo',
      isPublic: false,
    });
  });

  it('update → PATCH /studies/:slug', async () => {
    await studiesApi.update('demo', { name: 'New name' });
    expect(apiPatchMock).toHaveBeenCalledWith('/studies/demo', {
      name: 'New name',
    });
  });

  it('delete → DELETE /studies/:slug', async () => {
    await studiesApi.delete('demo');
    expect(apiDeleteMock).toHaveBeenCalledWith('/studies/demo');
  });

  it('share(slug, true) → PATCH /studies/:slug {isPublic:true}', async () => {
    await studiesApi.share('demo', true);
    expect(apiPatchMock).toHaveBeenCalledWith('/studies/demo', {
      isPublic: true,
    });
  });

  // --- Chapters ---

  it('getChapter → GET /studies/:slug/chapters/:id', async () => {
    await studiesApi.getChapter('demo', 'ch1');
    expect(apiGetMock).toHaveBeenCalledWith('/studies/demo/chapters/ch1');
  });

  it('createChapter → POST с телом', async () => {
    await studiesApi.createChapter('demo', { name: 'Ch1', pgn: '1. e4' });
    expect(apiPostMock).toHaveBeenCalledWith('/studies/demo/chapters', {
      name: 'Ch1',
      pgn: '1. e4',
    });
  });

  it('updateChapter → PATCH с телом', async () => {
    await studiesApi.updateChapter('demo', 'ch1', { name: 'Renamed' });
    expect(apiPatchMock).toHaveBeenCalledWith(
      '/studies/demo/chapters/ch1',
      { name: 'Renamed' },
    );
  });

  it('reorderChapter(after=null) → PATCH /order {after:null}', async () => {
    await studiesApi.reorderChapter('demo', 'ch1', null);
    expect(apiPatchMock).toHaveBeenCalledWith(
      '/studies/demo/chapters/ch1/order',
      { after: null },
    );
  });

  it('reorderChapter(after=id) → PATCH /order {after:id}', async () => {
    await studiesApi.reorderChapter('demo', 'ch1', 'ch2');
    expect(apiPatchMock).toHaveBeenCalledWith(
      '/studies/demo/chapters/ch1/order',
      { after: 'ch2' },
    );
  });

  it('deleteChapter → DELETE', async () => {
    await studiesApi.deleteChapter('demo', 'ch1');
    expect(apiDeleteMock).toHaveBeenCalledWith('/studies/demo/chapters/ch1');
  });

  // --- Import/Export ---

  it('importPgn → POST /studies/:slug/import-pgn {pgn}', async () => {
    await studiesApi.importPgn('demo', '[Event "x"]\n1. e4');
    expect(apiPostMock).toHaveBeenCalledWith(
      '/studies/demo/import-pgn',
      { pgn: '[Event "x"]\n1. e4' },
    );
  });

  it('exportPgn → GET /studies/:slug/export.pgn', async () => {
    await studiesApi.exportPgn('demo');
    expect(apiGetMock).toHaveBeenCalledWith('/studies/demo/export.pgn');
  });

  it('exportChapterPgn → GET /studies/:slug/chapters/:id/export.pgn', async () => {
    await studiesApi.exportChapterPgn('demo', 'ch1');
    expect(apiGetMock).toHaveBeenCalledWith(
      '/studies/demo/chapters/ch1/export.pgn',
    );
  });

  // --- Public ---

  it('getPublicChapter → GET /studies/public/c/:id', async () => {
    await studiesApi.getPublicChapter('ch1');
    expect(apiGetMock).toHaveBeenCalledWith('/studies/public/c/ch1');
  });
});
