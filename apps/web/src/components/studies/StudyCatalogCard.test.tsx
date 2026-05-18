import { describe, it, expect, vi } from 'vitest';
import type { StudyDto } from '@kingside/shared';

import { renderWithProviders, screen } from '../../test/test-utils';
import { StudyCatalogCard } from './StudyCatalogCard';

// KS-2888: LikeButton внутри карточки тянет useAuth. В тесте обёртка
// test-utils не предоставляет AuthProvider — мокаем хук в no-auth-
// состоянии (anon), чтобы render не падал.
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}));
vi.mock('../../api/studiesApi', () => ({
  studiesApi: { toggleLike: vi.fn() },
}));

/**
 * KS-2887 / ADR-060 §3.4 K5 (FC2). Юнит-проверка рендера карточки
 * каталога: содержит ли все нужные блоки (имя, описание, превью, автор,
 * лайки, главы, topics-chips) и корректно ли формирует href на студию.
 */

function makeStudy(over: Partial<StudyDto> = {}): StudyDto {
  return {
    id: 's1',
    ownerId: '11111111-2222-3333-4444-555555555555',
    slug: 'opening-traps',
    name: 'Opening traps',
    description: 'Сборник коротких ловушек в дебюте',
    isPublic: true,
    visibility: 'public',
    topics: ['openings', 'tactics'],
    likes: 17,
    fromKind: 'scratch',
    fromRefId: null,
    chaptersCount: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    // KS-2994 / KS-2995: backend отдаёт POV-флаги в StudyDto. Дефолт
    // anon: не лайкнул, viewerRole='anon' (mock useAuth в этом тесте
    // имитирует guest'а).
    likedByMe: false,
    viewerRole: 'anon',
    ...over,
  };
}

describe('StudyCatalogCard (KS-2887 FC2)', () => {
  it('рендерит все основные поля и ведёт на /studies/:slug', () => {
    const study = makeStudy();
    renderWithProviders(
      <StudyCatalogCard study={study} ownerUsername="tester" />,
    );
    const card = screen.getByTestId('study-catalog-card');
    expect(card.tagName).toBe('A');
    expect(card.getAttribute('href')).toBe('/studies/opening-traps');
    expect(card.getAttribute('data-study-id')).toBe('s1');
    expect(card.getAttribute('data-study-slug')).toBe('opening-traps');
    expect(screen.getByTestId('study-catalog-card-name').textContent).toBe(
      'Opening traps',
    );
    expect(
      screen.getByTestId('study-catalog-card-description').textContent,
    ).toBe('Сборник коротких ловушек в дебюте');
    expect(screen.getByTestId('study-catalog-card-author').textContent).toBe(
      '@tester',
    );
    expect(
      screen.getByTestId('study-catalog-card-chapters').textContent,
    ).toContain('4');
    expect(screen.getByTestId('study-catalog-card-likes').textContent).toContain(
      '17',
    );
    const topics = screen.getByTestId('study-catalog-card-topics');
    expect(topics.textContent).toContain('openings');
    expect(topics.textContent).toContain('tactics');
  });

  it('превью — SVG 80×80 с aria-label по имени студии', () => {
    const study = makeStudy({ name: 'Endgame essentials' });
    renderWithProviders(<StudyCatalogCard study={study} />);
    const preview = screen.getByTestId('study-catalog-card-preview');
    const svg = preview.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('width')).toBe('80');
    expect(svg!.getAttribute('height')).toBe('80');
    expect(svg!.getAttribute('aria-label')).toBe(
      'Preview of Endgame essentials',
    );
    // Стандартная стартовая позиция → 64 квадрата + 32 фигуры.
    const rects = svg!.querySelectorAll('rect');
    expect(rects.length).toBe(64);
    const pieces = svg!.querySelectorAll('text');
    expect(pieces.length).toBe(32);
  });

  it('рисует переданный previewFen, а не стартпоз', () => {
    // King-only endgame: только два короля. В SVG ожидаем 2 <text>.
    const study = makeStudy();
    renderWithProviders(
      <StudyCatalogCard
        study={study}
        previewFen="8/8/8/3k4/8/8/4K3/8 w - - 0 1"
      />,
    );
    const svg = screen.getByTestId('study-catalog-card-preview').querySelector('svg')!;
    expect(svg.querySelectorAll('text').length).toBe(2);
  });

  it('некорректный FEN → безопасный фолбэк на стартпоз (32 фигуры)', () => {
    const study = makeStudy();
    renderWithProviders(
      <StudyCatalogCard study={study} previewFen="not-a-fen" />,
    );
    const svg = screen.getByTestId('study-catalog-card-preview').querySelector('svg')!;
    expect(svg.querySelectorAll('text').length).toBe(32);
  });

  it('без описания — блок description не рендерится', () => {
    const study = makeStudy({ description: null });
    renderWithProviders(<StudyCatalogCard study={study} />);
    expect(
      screen.queryByTestId('study-catalog-card-description'),
    ).toBeNull();
  });

  it('без topics — блок topics не рендерится', () => {
    const study = makeStudy({ topics: [] });
    renderWithProviders(<StudyCatalogCard study={study} />);
    expect(screen.queryByTestId('study-catalog-card-topics')).toBeNull();
  });

  it('study.likedByMe=true → LikeButton сразу отрисован как liked (filled)', () => {
    // KS-2995 / ADR-060 §3.4 K4: backend в StudyDto несёт POV-флаг.
    // Карточка должна транслировать его в `<LikeButton liked={…}>` без
    // дефолта false. Acceptance: heart filled с первого рендера для
    // юзера, который уже лайкнул эту студию.
    const study = makeStudy({ likedByMe: true });
    renderWithProviders(<StudyCatalogCard study={study} />);
    const btn = screen.getByTestId('study-like-button');
    expect(btn.getAttribute('data-liked')).toBe('true');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('study.likedByMe=false → LikeButton outline', () => {
    const study = makeStudy({ likedByMe: false });
    renderWithProviders(<StudyCatalogCard study={study} />);
    const btn = screen.getByTestId('study-like-button');
    expect(btn.getAttribute('data-liked')).toBe('false');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('без ownerUsername — fallback на префикс ownerId', () => {
    const study = makeStudy({
      ownerId: 'abcd1234-ef56-7890-abcd-ef1234567890',
    });
    renderWithProviders(<StudyCatalogCard study={study} />);
    expect(screen.getByTestId('study-catalog-card-author').textContent).toBe(
      '@abcd1234',
    );
  });
});
