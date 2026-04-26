import { describe, it, expect } from 'vitest';

import { renderWithProviders, screen } from '../../test/test-utils';
import { CourseCard } from './CourseCard';

/**
 * KS-1942: CourseCard (M-размер). Проверяем:
 *  - полная shape (все поля, включая обложку, бейджи, прогресс, теги),
 *  - минимальная shape (только обязательные) — старые курсы без обогащения,
 *  - 3 варианта CTA локализованы и видимы,
 *  - placeholder обложки и иконка по уровню,
 *  - data-атрибуты для CSS-стилизации.
 */

describe('<CourseCard>', () => {
  it('full data: рендерит обложку, все бейджи, прогресс, теги, CTA', () => {
    renderWithProviders(
      <CourseCard
        slug="endgame-pawn"
        href="/lessons/endgame-pawn"
        title="Эндшпиль: пешечные структуры"
        level="intermediate"
        difficulty={2}
        estimatedMinutes={120}
        coverUrl="https://cdn/cover.jpg"
        audience="Для игроков 1200-1600"
        progress={{ done: 4, total: 8 }}
        ctaVariant="continue"
        tags={['эндшпиль', 'пешка']}
      />,
    );

    const card = screen.getByTestId('course-card-endgame-pawn');
    expect(card.getAttribute('data-level')).toBe('intermediate');
    expect(card.getAttribute('data-cta')).toBe('continue');

    // Cover — img
    const cover = screen.getByTestId('course-card-cover');
    expect(cover.getAttribute('data-source')).toBe('image');
    expect(cover.querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn/cover.jpg',
    );

    // Badges
    expect(screen.getByTestId('course-card-badge-level').textContent).toMatch(
      /Intermediate/i,
    );
    const stars = screen.getByTestId('course-card-difficulty');
    expect(stars.getAttribute('data-difficulty')).toBe('2');
    // 2 заполненных + 1 пустая
    expect(stars.querySelectorAll('.course-card__star--filled').length).toBe(2);
    expect(stars.querySelectorAll('.course-card__star--empty').length).toBe(1);
    expect(
      screen.getByTestId('course-card-badge-duration').textContent,
    ).toMatch(/2/);

    // Title
    expect(screen.getByTestId('course-card-title').textContent).toBe(
      'Эндшпиль: пешечные структуры',
    );

    // Audience
    expect(screen.getByTestId('course-card-audience').textContent).toBe(
      'Для игроков 1200-1600',
    );

    // Progress
    const fill = screen.getByTestId('course-card-progress-fill');
    expect(fill.getAttribute('style')).toContain('width: 50%');
    expect(screen.getByTestId('course-card-progress').textContent).toMatch(
      /4.*8|4\/8/,
    );

    // CTA
    expect(screen.getByTestId('course-card-cta').getAttribute('data-variant')).toBe(
      'continue',
    );
    expect(screen.getByTestId('course-card-cta').textContent).toMatch(
      /continue|продолжить/i,
    );

    // Tags
    const tags = screen.getByTestId('course-card-tags');
    expect(tags.querySelectorAll('li').length).toBe(2);
    expect(tags.textContent).toMatch(/#эндшпиль/);
    expect(tags.textContent).toMatch(/#пешка/);

    // Link href
    expect(
      screen
        .getByTestId('course-card-endgame-pawn-link')
        .getAttribute('href'),
    ).toBe('/lessons/endgame-pawn');
  });

  it('minimal data (старые курсы без обогащения): рендерится без падений', () => {
    renderWithProviders(
      <CourseCard
        slug="legacy"
        href="/lessons/legacy"
        title="Legacy course"
        ctaVariant="start"
      />,
    );

    expect(screen.getByTestId('course-card-legacy')).toBeInTheDocument();
    expect(screen.getByTestId('course-card-title').textContent).toBe(
      'Legacy course',
    );

    // Бейджи, audience, прогресс, теги — отсутствуют
    expect(screen.queryByTestId('course-card-badge-level')).toBeNull();
    expect(screen.queryByTestId('course-card-difficulty')).toBeNull();
    expect(screen.queryByTestId('course-card-badge-duration')).toBeNull();
    expect(screen.queryByTestId('course-card-audience')).toBeNull();
    expect(screen.queryByTestId('course-card-progress')).toBeNull();
    expect(screen.queryByTestId('course-card-tags')).toBeNull();

    // Cover — placeholder с нейтральной иконкой 📘 (level=null)
    const cover = screen.getByTestId('course-card-cover');
    expect(cover.getAttribute('data-source')).toBe('placeholder');
    expect(cover.getAttribute('data-level')).toBe('none');
    expect(cover.textContent).toContain('📘');

    // CTA — start
    expect(
      screen.getByTestId('course-card-cta').getAttribute('data-variant'),
    ).toBe('start');
  });

  it('placeholder обложки: фигура зависит от level', () => {
    const { rerender } = renderWithProviders(
      <CourseCard
        slug="b"
        href="/x"
        title="Beginner"
        level="beginner"
        ctaVariant="start"
      />,
    );
    expect(screen.getByTestId('course-card-cover').textContent).toContain('♟');

    rerender(
      <CourseCard
        slug="i"
        href="/x"
        title="Intermediate"
        level="intermediate"
        ctaVariant="start"
      />,
    );
    expect(screen.getByTestId('course-card-cover').textContent).toContain('♞');

    rerender(
      <CourseCard
        slug="a"
        href="/x"
        title="Advanced"
        level="advanced"
        ctaVariant="start"
      />,
    );
    expect(screen.getByTestId('course-card-cover').textContent).toContain('♛');
  });

  it('CTA «start» / «preview» рендерятся с разной локализацией', () => {
    const { rerender } = renderWithProviders(
      <CourseCard
        slug="x"
        href="/x"
        title="X"
        ctaVariant="start"
      />,
    );
    expect(screen.getByTestId('course-card-cta').textContent).toMatch(
      /start|начать/i,
    );

    rerender(
      <CourseCard
        slug="x"
        href="/x"
        title="X"
        ctaVariant="preview"
      />,
    );
    expect(screen.getByTestId('course-card-cta').textContent).toMatch(
      /preview|посмотреть/i,
    );
  });

  it('estimatedMinutes: < 60 → минуты, ≥ 60 → часы', () => {
    const { rerender } = renderWithProviders(
      <CourseCard
        slug="m"
        href="/x"
        title="M"
        estimatedMinutes={45}
        ctaVariant="start"
      />,
    );
    expect(
      screen.getByTestId('course-card-badge-duration').textContent,
    ).toMatch(/45/);

    rerender(
      <CourseCard
        slug="m"
        href="/x"
        title="M"
        estimatedMinutes={120}
        ctaVariant="start"
      />,
    );
    expect(
      screen.getByTestId('course-card-badge-duration').textContent,
    ).toMatch(/2/);
  });

  it('progress total=0 → бар не рендерится (защита от деления на 0)', () => {
    renderWithProviders(
      <CourseCard
        slug="z"
        href="/x"
        title="Z"
        progress={{ done: 0, total: 0 }}
        ctaVariant="start"
      />,
    );
    expect(screen.queryByTestId('course-card-progress')).toBeNull();
  });

  it('пустые теги (только пробелы) отсеиваются', () => {
    renderWithProviders(
      <CourseCard
        slug="t"
        href="/x"
        title="T"
        tags={['real', '   ', '']}
        ctaVariant="start"
      />,
    );
    const tags = screen.getByTestId('course-card-tags');
    expect(tags.querySelectorAll('li').length).toBe(1);
    expect(tags.textContent).toMatch(/#real/);
  });

  it('KS-1956: recencyBadge передан → рендерится внутри карточки', () => {
    renderWithProviders(
      <CourseCard
        slug="r"
        href="/x"
        title="R"
        ctaVariant="continue"
        recencyBadge="2 days ago"
      />,
    );
    const card = screen.getByTestId('course-card-r');
    const recency = card.querySelector('[data-testid="course-card-recency"]');
    expect(recency).not.toBeNull();
    expect(recency?.textContent).toBe('2 days ago');
  });

  it('KS-1956: без recencyBadge — отдельный slot не рендерится', () => {
    renderWithProviders(
      <CourseCard slug="r" href="/x" title="R" ctaVariant="start" />,
    );
    expect(screen.queryByTestId('course-card-recency')).toBeNull();
  });

  it('кастомный testId переопределяет дефолт', () => {
    renderWithProviders(
      <CourseCard
        testId="custom-card"
        slug="x"
        href="/x"
        title="X"
        ctaVariant="start"
      />,
    );
    expect(screen.getByTestId('custom-card')).toBeInTheDocument();
    expect(screen.queryByTestId('course-card-x')).toBeNull();
  });
});
