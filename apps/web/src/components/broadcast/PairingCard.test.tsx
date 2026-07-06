import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BroadcastGameSummary } from '@kingside/shared';
import { PairingCard } from './PairingCard';

/**
 * KS-4848 / ADR-158 §2.4.1: карточка пары до старта.
 */
function makeGame(overrides: Partial<BroadcastGameSummary> = {}): BroadcastGameSummary {
  return {
    id: 'g1',
    lichessGameId: 'lg1',
    whitePlayer: 'Carlsen, M',
    blackPlayer: 'Nakamura, H',
    whiteElo: 2830,
    blackElo: 2789,
    result: null,
    pgn: null,
    currentFen: null,
    updatedAt: '2026-07-06T10:00:00.000Z',
    bracketStage: null,
    bracketPairId: null,
    matchScore: null,
    ...overrides,
  };
}

describe('PairingCard (KS-4848)', () => {
  it('рендерит имена игроков и рейтинги', () => {
    render(<PairingCard game={makeGame()} />);
    const card = screen.getByTestId('broadcast-pairing-card-g1');
    expect(card.textContent).toContain('Carlsen, M');
    expect(card.textContent).toContain('(2830)');
    expect(card.textContent).toContain('Nakamura, H');
    expect(card.textContent).toContain('(2789)');
  });

  it('без рейтингов — только имена', () => {
    render(<PairingCard game={makeGame({ whiteElo: null, blackElo: null })} />);
    const card = screen.getByTestId('broadcast-pairing-card-g1');
    expect(card.textContent).toContain('Carlsen, M');
    expect(card.textContent).not.toContain('(');
  });

  it('без onClick — не кликабельна, роль не button', () => {
    render(<PairingCard game={makeGame()} />);
    const card = screen.getByTestId('broadcast-pairing-card-g1');
    expect(card).not.toHaveAttribute('role');
    expect(card.className).not.toContain('--clickable');
  });

  it('с onClick — вызывает handler по клику', async () => {
    const spy = vi.fn();
    render(<PairingCard game={makeGame()} onClick={spy} />);
    const card = screen.getByTestId('broadcast-pairing-card-g1');
    expect(card).toHaveAttribute('role', 'button');
    await userEvent.click(card);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].id).toBe('g1');
  });

  it('null whitePlayer → «—» вместо имени', () => {
    render(<PairingCard game={makeGame({ whitePlayer: null, whiteElo: null })} />);
    const card = screen.getByTestId('broadcast-pairing-card-g1');
    expect(card.textContent).toContain('—');
  });
});
