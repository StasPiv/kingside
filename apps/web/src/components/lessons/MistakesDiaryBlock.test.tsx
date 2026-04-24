import { describe, it, expect } from 'vitest';
import type { UserMistakeAggregate } from '@kingside/shared';

import { renderWithProviders, screen } from '../../test/test-utils';
import { MistakesDiaryBlock } from './MistakesDiaryBlock';

function agg(partial: Partial<UserMistakeAggregate>): UserMistakeAggregate {
  return {
    theme: 'fork',
    count: 5,
    lastOccurredAt: '2026-04-22T00:00:00.000Z',
    ...partial,
  } as UserMistakeAggregate;
}

describe('<MistakesDiaryBlock>', () => {
  it('пустой список → блок не рендерится', () => {
    renderWithProviders(
      <MistakesDiaryBlock aggregates={[]} totalThemes={0} />,
    );
    expect(
      screen.queryByTestId('mistakes-diary-block'),
    ).not.toBeInTheDocument();
  });

  it('errored → блок не рендерится', () => {
    renderWithProviders(
      <MistakesDiaryBlock aggregates={[]} totalThemes={0} errored />,
    );
    expect(
      screen.queryByTestId('mistakes-diary-block'),
    ).not.toBeInTheDocument();
  });

  it('рендерит список + CTA с ?theme=', () => {
    renderWithProviders(
      <MistakesDiaryBlock
        aggregates={[agg({ theme: 'fork', count: 10 })]}
        totalThemes={1}
      />,
    );
    expect(screen.getByTestId('mistakes-diary-block')).toBeInTheDocument();
    expect(screen.getByTestId('mistakes-diary-cta-fork')).toHaveAttribute(
      'href',
      '/lessons/mistakes-practice?theme=fork',
    );
  });

  it('обрезает список до 5 элементов (топ-5)', () => {
    const items: UserMistakeAggregate[] = [
      agg({ theme: 'fork', count: 10 }),
      agg({ theme: 'pin', count: 8 }),
      agg({ theme: 'skewer', count: 6 }),
      agg({ theme: 'mate', count: 5 }),
      agg({ theme: 'sacrifice', count: 4 }),
      agg({ theme: 'endgame', count: 2 }),
      agg({ theme: 'middlegame', count: 1 }),
    ];
    renderWithProviders(
      <MistakesDiaryBlock aggregates={items} totalThemes={7} />,
    );
    expect(screen.getByTestId('mistakes-diary-item-fork')).toBeInTheDocument();
    expect(screen.getByTestId('mistakes-diary-item-sacrifice')).toBeInTheDocument();
    // 6-й и 7-й элементы не должны рендериться в блоке
    expect(
      screen.queryByTestId('mistakes-diary-item-endgame'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('mistakes-diary-item-middlegame'),
    ).not.toBeInTheDocument();
    // При обрезке показываем «Смотреть всё»
    expect(screen.getByTestId('mistakes-diary-see-all')).toBeInTheDocument();
  });

  it('«Смотреть всё» скрыто, когда totalThemes ≤ показанных', () => {
    renderWithProviders(
      <MistakesDiaryBlock
        aggregates={[agg({ theme: 'fork' }), agg({ theme: 'pin' })]}
        totalThemes={2}
      />,
    );
    expect(
      screen.queryByTestId('mistakes-diary-see-all'),
    ).not.toBeInTheDocument();
  });

  it('счётчик тем в header использует totalThemes', () => {
    renderWithProviders(
      <MistakesDiaryBlock
        aggregates={[agg({ theme: 'fork' })]}
        totalThemes={15}
      />,
    );
    expect(screen.getByTestId('mistakes-diary-total')).toHaveTextContent('15');
  });

  it('URL-encoding в theme (безопасность)', () => {
    renderWithProviders(
      <MistakesDiaryBlock
        aggregates={[agg({ theme: 'fork&mate' as UserMistakeAggregate['theme'] })]}
        totalThemes={1}
      />,
    );
    expect(
      screen.getByTestId('mistakes-diary-cta-fork&mate'),
    ).toHaveAttribute(
      'href',
      '/lessons/mistakes-practice?theme=fork%26mate',
    );
  });
});
