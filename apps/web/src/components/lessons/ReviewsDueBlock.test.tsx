import { describe, it, expect } from 'vitest';
import type { ReviewDueItem } from '@kingside/shared';

import { renderWithProviders, screen } from '../../test/test-utils';
import { ReviewsDueBlock } from './ReviewsDueBlock';

function item(partial: Partial<ReviewDueItem>): ReviewDueItem {
  return {
    courseSlug: 'beginner-basics',
    courseTitleI18nKey: 'beginner-basics-title',
    lessonSlug: 'pieces',
    lessonTitleI18nKey: 'pieces-title',
    dueAt: '2026-04-24T00:00:00.000Z',
    lastReviewedAt: '2026-04-17T00:00:00.000Z',
    intervalDays: 7,
    ...partial,
  };
}

describe('<ReviewsDueBlock>', () => {
  it('пустой список → блок не рендерится', () => {
    renderWithProviders(<ReviewsDueBlock items={[]} />);
    expect(screen.queryByTestId('reviews-due-block')).not.toBeInTheDocument();
  });

  it('errored=true → блок не рендерится', () => {
    renderWithProviders(<ReviewsDueBlock items={[]} errored />);
    expect(screen.queryByTestId('reviews-due-block')).not.toBeInTheDocument();
  });

  it('список из одного элемента → блок + CTA с ?mode=review', () => {
    renderWithProviders(<ReviewsDueBlock items={[item({})]} />);
    expect(screen.getByTestId('reviews-due-block')).toBeInTheDocument();
    expect(screen.getByTestId('reviews-due-count')).toHaveTextContent('1');
    expect(screen.getByTestId('reviews-due-cta-pieces')).toHaveAttribute(
      'href',
      '/lessons/beginner-basics/pieces?mode=review',
    );
  });

  it('lastReviewedAt=null → подпись «Впервые повторяешь» / «First review»', () => {
    renderWithProviders(
      <ReviewsDueBlock items={[item({ lastReviewedAt: null })]} />,
    );
    const meta = screen.getByTestId('reviews-due-lastreviewed-pieces');
    expect(meta.textContent).toMatch(/first review|впервые/i);
  });

  it('несколько элементов рендерятся в порядке прихода', () => {
    renderWithProviders(
      <ReviewsDueBlock
        items={[
          item({ lessonSlug: 'a', lessonTitleI18nKey: 'a-title' }),
          item({ lessonSlug: 'b', lessonTitleI18nKey: 'b-title' }),
          item({ lessonSlug: 'c', lessonTitleI18nKey: 'c-title' }),
        ]}
      />,
    );
    expect(screen.getByTestId('reviews-due-item-a')).toBeInTheDocument();
    expect(screen.getByTestId('reviews-due-item-b')).toBeInTheDocument();
    expect(screen.getByTestId('reviews-due-item-c')).toBeInTheDocument();
    expect(screen.getByTestId('reviews-due-count')).toHaveTextContent('3');
  });

  it('URL-encoding в slug не ломает CTA', () => {
    renderWithProviders(
      <ReviewsDueBlock
        items={[item({ courseSlug: 'basic/intro', lessonSlug: 'a&b' })]}
      />,
    );
    expect(screen.getByTestId('reviews-due-cta-a&b')).toHaveAttribute(
      'href',
      '/lessons/basic%2Fintro/a%26b?mode=review',
    );
  });
});
