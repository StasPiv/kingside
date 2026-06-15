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
