/**
 * KS-4220 / ADR-128 §7.6.1.2 L2. Тест JSON-LD `Course.provider`:
 *  - при `lecture.coach.username` → `Person` с url'ом профиля тренера.
 *  - при `lecture.coach === null` → fallback `Organization(Kingside)`.
 *
 * `useLectureDetail` мокается на возврат заранее подготовленного
 * `LectureDetail`. Сам React 19 поднимает `<script type="application/ld+json">`
 * в head; парсим и читаем поле `provider`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

import { renderWithProviders } from '../test/test-utils';
import type { LectureDetail } from '@kingside/shared';
import { LectureLandingPage } from './LectureLandingPage';

vi.mock('../hooks/useLectureDetail', () => ({
  useLectureDetail: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({ id: 'lec-1' }),
    Navigate: () => null,
  };
});

import { useLectureDetail } from '../hooks/useLectureDetail';
const useLectureDetailMock = vi.mocked(useLectureDetail);

function makeLecture(overrides: Partial<LectureDetail> = {}): LectureDetail {
  return {
    id: 'lec-1',
    ownerId: 'owner-1',
    title: 'Endgame fundamentals',
    description: 'Pawn endings and king activity.',
    scheduledAt: null,
    startedAt: '2026-06-10T15:35:37.492Z',
    endedAt: '2026-06-10T15:37:45.201Z',
    durationMs: 130_000,
    status: 'recorded',
    visibility: 'public',
    liveAnalysisId: null,
    recordingId: 'rec-1',
    mediaUrl: null,
    mediaKind: null,
    createdAt: '2026-06-10T15:30:00.000Z',
    updatedAt: '2026-06-10T15:40:00.000Z',
    liveAnalysis: null,
    disabledTools: [],
    hideMetricsTab: false,
    coach: { id: 'coach-1', username: 'magnus' },
    ...overrides,
  };
}

function findMetaDescription(): string | null {
  const tags = document.head.querySelectorAll('meta[name="description"]');
  // React 19 поднимает meta из JSX последним — берём именно последний,
  // как делает дедупликатор в SeoHelmet.
  const last = tags[tags.length - 1] as HTMLMetaElement | undefined;
  return last?.getAttribute('content') ?? null;
}

function findCourseJsonLd(): Record<string, unknown> | null {
  const scripts = document.querySelectorAll(
    'script[type="application/ld+json"]',
  );
  for (const s of scripts) {
    try {
      const parsed = JSON.parse(s.textContent ?? 'null') as Record<
        string,
        unknown
      > | null;
      if (parsed && parsed['@type'] === 'Course') return parsed;
    } catch {
      /* skip */
    }
  }
  return null;
}

describe('LectureLandingPage JSON-LD provider (KS-4220)', () => {
  beforeEach(() => {
    document.head
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((n) => n.remove());
  });
  afterEach(() => {
    cleanup();
    useLectureDetailMock.mockReset();
  });

  it('provider:Person(coach.username) with /coach/:username url', () => {
    useLectureDetailMock.mockReturnValue({
      loading: false,
      lecture: makeLecture({
        coach: { id: 'coach-1', username: 'magnus' },
      }),
      error: null,
      refetch: vi.fn(),
    });

    renderWithProviders(<LectureLandingPage />);
    const jsonLd = findCourseJsonLd();
    expect(jsonLd).not.toBeNull();
    expect(jsonLd?.provider).toEqual({
      '@type': 'Person',
      name: 'magnus',
      url: 'https://kingside.site/coach/magnus',
    });
  });

  it('provider:Organization(Kingside) fallback when coach is null', () => {
    useLectureDetailMock.mockReturnValue({
      loading: false,
      lecture: makeLecture({ coach: null }),
      error: null,
      refetch: vi.fn(),
    });

    renderWithProviders(<LectureLandingPage />);
    const jsonLd = findCourseJsonLd();
    expect(jsonLd).not.toBeNull();
    expect(jsonLd?.provider).toEqual({
      '@type': 'Organization',
      name: 'Kingside',
      url: 'https://kingside.site',
    });
  });
});

describe('LectureLandingPage SEO description recorded (KS-4283)', () => {
  beforeEach(() => {
    document.head
      .querySelectorAll('meta[name="description"]')
      .forEach((n) => n.remove());
  });
  afterEach(() => {
    cleanup();
    useLectureDetailMock.mockReset();
  });

  it('renders full description when lecture.description is present', () => {
    useLectureDetailMock.mockReturnValue({
      loading: false,
      lecture: makeLecture({
        title: 'Endgame fundamentals',
        description: 'Pawn endings and king activity.',
        coach: { id: 'c-1', username: 'magnus' },
        status: 'recorded',
      }),
      error: null,
      refetch: vi.fn(),
    });

    renderWithProviders(<LectureLandingPage />);
    const desc = findMetaDescription();
    expect(desc).toBe(
      'Endgame fundamentals by magnus. Pawn endings and king activity. Watch the recording on Kingside.',
    );
    expect(desc).not.toContain('. .');
  });

  it('omits empty description segment without double dot', () => {
    useLectureDetailMock.mockReturnValue({
      loading: false,
      lecture: makeLecture({
        title: 'Vykouk, Jan vs Samarth Sreeni Warrier',
        description: '',
        coach: { id: 'c-1', username: 'Stanislav' },
        status: 'recorded',
      }),
      error: null,
      refetch: vi.fn(),
    });

    renderWithProviders(<LectureLandingPage />);
    const desc = findMetaDescription();
    expect(desc).toBe(
      'Vykouk, Jan vs Samarth Sreeni Warrier by Stanislav. Watch the recording on Kingside.',
    );
    expect(desc).not.toContain('. .');
  });

  it('treats whitespace-only description as empty', () => {
    useLectureDetailMock.mockReturnValue({
      loading: false,
      lecture: makeLecture({
        title: 'A vs B',
        description: '   ',
        coach: { id: 'c-1', username: 'tester' },
        status: 'recorded',
      }),
      error: null,
      refetch: vi.fn(),
    });

    renderWithProviders(<LectureLandingPage />);
    const desc = findMetaDescription();
    expect(desc).toBe('A vs B by tester. Watch the recording on Kingside.');
    expect(desc).not.toContain('. .');
  });
});

