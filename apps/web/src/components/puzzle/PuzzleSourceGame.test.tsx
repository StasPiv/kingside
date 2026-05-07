/**
 * KS-2488. Тесты `PuzzleSourceGame` — варианты `sourceGame`:
 * полный набор / только archiveGameId / только pgnUrl / отсутствует
 * / частичные headers.
 */
import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PuzzleSourceGame } from './PuzzleSourceGame';

describe('<PuzzleSourceGame> KS-2488', () => {
  it('undefined source → не рендерится (null, без пустого div)', () => {
    const { container } = renderWithProviders(<PuzzleSourceGame />);
    expect(container.querySelector('[data-testid="puzzle-source-game"]')).toBeNull();
  });

  it('пустой объект (все поля undefined) → не рендерится', () => {
    const { container } = renderWithProviders(
      <PuzzleSourceGame source={{}} />,
    );
    expect(container.querySelector('[data-testid="puzzle-source-game"]')).toBeNull();
  });

  it('полный набор: white+black, event, date, result, archiveId, pgnUrl', () => {
    renderWithProviders(
      <PuzzleSourceGame
        source={{
          white: 'Magnus Carlsen',
          black: 'Hikaru Nakamura',
          event: 'World Blitz 2024',
          date: '2024.12.30',
          result: '1-0',
          archiveGameId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
          pgnUrl: 'https://lichess.org/abcd1234',
        }}
      />,
    );
    const root = screen.getByTestId('puzzle-source-game');
    expect(root).toBeInTheDocument();
    const headers = screen.getByTestId('puzzle-source-game-headers');
    // headers строка содержит все поля.
    expect(headers.textContent).toMatch(/Magnus Carlsen.*Hikaru Nakamura/);
    expect(headers.textContent).toContain('World Blitz 2024');
    expect(headers.textContent).toContain('2024.12.30');
    expect(headers.textContent).toContain('1-0');
    // archive-link с правильным href.
    const archive = screen.getByTestId('puzzle-source-game-archive-link');
    expect(archive.getAttribute('href')).toBe(
      '/archive/games/a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    );
    // pgn-link с target=_blank.
    const pgn = screen.getByTestId('puzzle-source-game-pgn-link');
    expect(pgn.getAttribute('href')).toBe('https://lichess.org/abcd1234');
    expect(pgn.getAttribute('target')).toBe('_blank');
    expect(pgn.getAttribute('rel')).toMatch(/noopener/);
  });

  it('только archiveGameId (generated пазл) → archive-link, нет pgn-link, нет headers', () => {
    renderWithProviders(
      <PuzzleSourceGame
        source={{ archiveGameId: '00006f9b-275e-4a48-9009-29e07dcf61bf' }}
      />,
    );
    expect(screen.getByTestId('puzzle-source-game')).toBeInTheDocument();
    expect(screen.getByTestId('puzzle-source-game-archive-link')).toBeInTheDocument();
    expect(
      screen.queryByTestId('puzzle-source-game-pgn-link'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('puzzle-source-game-headers'),
    ).not.toBeInTheDocument();
  });

  it('только pgnUrl (Lichess пазл) → pgn-link, нет archive-link, нет headers', () => {
    renderWithProviders(
      <PuzzleSourceGame
        source={{ pgnUrl: 'https://lichess.org/abcd1234' }}
      />,
    );
    expect(screen.getByTestId('puzzle-source-game')).toBeInTheDocument();
    expect(screen.getByTestId('puzzle-source-game-pgn-link')).toBeInTheDocument();
    expect(
      screen.queryByTestId('puzzle-source-game-archive-link'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('puzzle-source-game-headers'),
    ).not.toBeInTheDocument();
  });

  it('частичные headers: только white → headers рендерятся без « − »', () => {
    renderWithProviders(
      <PuzzleSourceGame source={{ white: 'Carlsen', event: 'World Blitz' }} />,
    );
    const h = screen.getByTestId('puzzle-source-game-headers');
    expect(h.textContent).toContain('Carlsen');
    expect(h.textContent).toContain('World Blitz');
    expect(h.textContent).not.toContain(' − ');
  });

  it('headers без archive/pgn → блок с links не рендерится', () => {
    renderWithProviders(
      <PuzzleSourceGame source={{ white: 'A', black: 'B', date: '2024.01.01' }} />,
    );
    expect(screen.getByTestId('puzzle-source-game-headers')).toBeInTheDocument();
    expect(
      screen.queryByTestId('puzzle-source-game-archive-link'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('puzzle-source-game-pgn-link'),
    ).not.toBeInTheDocument();
  });
});
