import { describe, it, expect } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';
import { WdlChancesBar, wdlShares } from './WdlChancesBar';
import type { WdlDistribution } from '../utils/engineAdapter';

/**
 * KS-3391 — трёхцветная полоса шансов W/D/L (precision).
 *
 * Проверяем:
 *  - чистый хелпер `wdlShares`: доли в % пропорциональны WDL, сумма = 100,
 *    защита от деления на ноль;
 *  - loading-состояние при wdl=null (нейтральная полоса без скачков);
 *  - три сегмента win/draw/loss с пропорциональными ширинами;
 *  - POV: компонент агностичен — рисует переданный wdl как есть, поэтому
 *    «перевёрнутый» wdl (POV соперника) даёт зеркальную полосу. Семантика
 *    «победа решателя» — ответственность caller'а (latestWdl уже flipped).
 */

describe('wdlShares — KS-3391 доли сегментов', () => {
  it('пропорционально переводит промилле в проценты, сумма = 100', () => {
    const s = wdlShares({ w: 600, d: 300, l: 100 });
    expect(s.w).toBeCloseTo(60);
    expect(s.d).toBeCloseTo(30);
    expect(s.l).toBeCloseTo(10);
    expect(s.w + s.d + s.l).toBeCloseTo(100);
  });

  it('нормирует, если сумма промилле ≠ 1000 (округление Stockfish)', () => {
    const s = wdlShares({ w: 500, d: 400, l: 200 }); // total 1100
    expect(s.w + s.d + s.l).toBeCloseTo(100);
    expect(s.w).toBeCloseTo((500 / 1100) * 100);
  });

  it('при нулевой сумме отдаёт нейтральную ничью (защита от /0)', () => {
    expect(wdlShares({ w: 0, d: 0, l: 0 })).toEqual({ w: 0, d: 100, l: 0 });
  });
});

describe('<WdlChancesBar> — KS-3391 рендер', () => {
  it('loading: wdl=null → нейтральная полоса без числовых значений', () => {
    renderWithProviders(<WdlChancesBar wdl={null} />);
    const bar = screen.getByTestId('wdl-chances-bar');
    expect(bar).toHaveAttribute('data-loading', 'true');
    expect(bar.querySelector('.wdl-chances-bar__seg--loading')).not.toBeNull();
    // Нет сегментов win/loss до первой оценки.
    expect(screen.queryByTestId('wdl-chances-bar-win')).toBeNull();
  });

  it('рендерит три сегмента с пропорциональными ширинами', () => {
    const wdl: WdlDistribution = { w: 600, d: 300, l: 100 };
    renderWithProviders(<WdlChancesBar wdl={wdl} />);

    const bar = screen.getByTestId('wdl-chances-bar');
    expect(bar).toHaveAttribute('data-loading', 'false');
    expect(bar).toHaveAttribute('data-w', '60');
    expect(bar).toHaveAttribute('data-d', '30');
    expect(bar).toHaveAttribute('data-l', '10');

    const win = screen.getByTestId('wdl-chances-bar-win');
    const draw = screen.getByTestId('wdl-chances-bar-draw');
    const loss = screen.getByTestId('wdl-chances-bar-loss');
    expect(win).toHaveStyle({ width: '60%' });
    expect(draw).toHaveStyle({ width: '30%' });
    expect(loss).toHaveStyle({ width: '10%' });
  });

  it('подпись % показывается только в достаточно широких сегментах', () => {
    // l=5% < порога (14%) — без подписи; w=80% и d=15% — с подписью.
    renderWithProviders(<WdlChancesBar wdl={{ w: 800, d: 150, l: 50 }} />);
    const win = screen.getByTestId('wdl-chances-bar-win');
    const loss = screen.getByTestId('wdl-chances-bar-loss');
    expect(win.querySelector('.wdl-chances-bar__label')?.textContent).toBe('80%');
    expect(loss.querySelector('.wdl-chances-bar__label')).toBeNull();
  });

  it('POV: «перевёрнутый» wdl (POV соперника) зеркалит сегменты', () => {
    // Решатель доминирует: win 70 / loss 10.
    const solverPov: WdlDistribution = { w: 700, d: 200, l: 100 };
    // Тот же расклад POV соперника — w↔l (так caller инвертирует через
    // flipWdl до передачи в bar). Если бы caller НЕ инвертировал, полоса
    // показала бы поражение решателя как победу — регрессия KS-2519/2527.
    const opponentPov: WdlDistribution = { w: 100, d: 200, l: 700 };

    const { rerender } = renderWithProviders(<WdlChancesBar wdl={solverPov} />);
    expect(screen.getByTestId('wdl-chances-bar')).toHaveAttribute('data-w', '70');

    rerender(<WdlChancesBar wdl={opponentPov} />);
    // Без flip win-сегмент решателя «схлопнулся» бы до 10% — демонстрация
    // важности POV-инверсии на стороне caller'а.
    expect(screen.getByTestId('wdl-chances-bar')).toHaveAttribute('data-w', '10');
  });

  it('aria-label описывает доли W/D/L для скринридера', () => {
    renderWithProviders(<WdlChancesBar wdl={{ w: 500, d: 400, l: 100 }} />);
    const bar = screen.getByTestId('wdl-chances-bar');
    expect(bar.getAttribute('aria-label')).toMatch(/Win 50%.*Draw 40%.*Loss 10%/);
  });
});
