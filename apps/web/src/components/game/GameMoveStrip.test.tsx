import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, userEvent } from '../../test/test-utils';
import { GameMoveStrip } from './GameMoveStrip';

describe('KS-4291 / ADR-134 §3: GameMoveStrip', () => {
  beforeEach(() => {
    // jsdom не реализует scrollIntoView — заглушаем для эффекта в
    // useEffect компонента.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('пустой список ходов: рендерит контейнер без элементов', () => {
    renderWithProviders(<GameMoveStrip moves={[]} />);
    const strip = screen.getByTestId('game-move-strip');
    expect(strip).toBeInTheDocument();
    expect(
      strip.querySelectorAll('[data-testid^="game-move-strip-item-"]').length,
    ).toBe(0);
  });

  it('форматирует пары ходов с номерами (1.e4 e5 2.Nf3 Nc6)', () => {
    renderWithProviders(
      <GameMoveStrip moves={['e4', 'e5', 'Nf3', 'Nc6']} />,
    );
    expect(screen.getByTestId('game-move-strip-item-0')).toHaveTextContent(
      '1.e4',
    );
    expect(screen.getByTestId('game-move-strip-item-1')).toHaveTextContent('e5');
    expect(screen.getByTestId('game-move-strip-item-2')).toHaveTextContent(
      '2.Nf3',
    );
    expect(screen.getByTestId('game-move-strip-item-3')).toHaveTextContent(
      'Nc6',
    );
  });

  it('последний ход помечен классом `current`', () => {
    renderWithProviders(
      <GameMoveStrip moves={['e4', 'e5', 'Nf3']} />,
    );
    expect(screen.getByTestId('game-move-strip-item-0')).not.toHaveClass(
      'current',
    );
    expect(screen.getByTestId('game-move-strip-item-1')).not.toHaveClass(
      'current',
    );
    expect(screen.getByTestId('game-move-strip-item-2')).toHaveClass('current');
  });

  it('scrollIntoView вызывается при появлении нового хода', () => {
    const spy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    const { rerender } = renderWithProviders(
      <GameMoveStrip moves={['e4']} />,
    );
    // Первый mount — один вызов от useEffect.
    expect(spy).toHaveBeenCalled();
    spy.mockClear();
    rerender(<GameMoveStrip moves={['e4', 'e5']} />);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('коллбэк onMoveClick получает индекс полу-хода (если передан)', async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <GameMoveStrip moves={['e4', 'e5', 'Nf3']} onMoveClick={onClick} />,
    );
    await userEvent.click(screen.getByTestId('game-move-strip-item-2'));
    expect(onClick).toHaveBeenCalledWith(2);
  });

  it('без onMoveClick тап по ходу ничего не вызывает', async () => {
    renderWithProviders(<GameMoveStrip moves={['e4']} />);
    await userEvent.click(screen.getByTestId('game-move-strip-item-0'));
    // Не падает, не бросает.
  });
});
