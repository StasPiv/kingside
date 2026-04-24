import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';

const flagControls = { lessons: true };
vi.mock('../config/featureFlags', () => ({
  isLessonsEnabledLive: () => flagControls.lessons,
  areDevRoutesEnabledLive: () => true,
}));

// FeedbackModal зависит от api-запроса, для теста сайдбара не нужен.
vi.mock('./FeedbackModal', () => ({
  FeedbackModal: () => <div data-testid="feedback-modal-mock" />,
}));

import { Sidebar } from './Sidebar';

beforeEach(() => {
  flagControls.lessons = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<Sidebar>', () => {
  it('флаг on → пункт «Уроки» виден в меню', () => {
    flagControls.lessons = true;
    renderWithProviders(<Sidebar />);
    expect(screen.getByTitle(/lessons|уроки/i)).toBeInTheDocument();
  });

  it('флаг off → пункт «Уроки» скрыт', () => {
    flagControls.lessons = false;
    renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/lessons|уроки/i)).not.toBeInTheDocument();
  });

  it('остальные пункты меню на месте при флаге off', () => {
    flagControls.lessons = false;
    renderWithProviders(<Sidebar />);
    // Несколько непересекающихся пунктов — они никак не зависят от флага.
    expect(screen.getByTitle(/play/i)).toBeInTheDocument();
    expect(screen.getByTitle(/workshop|мастерская/i)).toBeInTheDocument();
    expect(screen.getByTitle(/settings|настройки/i)).toBeInTheDocument();
  });
});
