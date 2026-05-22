/**
 * KS-3002 (ADR-065 §5.1.1, Этап 3 F1). Тесты `<PrecisionScoreBlock />`.
 *
 * Покрытие:
 *  - количество заполненных звёзд = score для всех 5 значений;
 *  - тон/CSS-класс по таблице §4.2;
 *  - accuracy% выводится строкой;
 *  - текстовая интерпретация различается по score;
 *  - не-integer / выход за диапазон зажимаются и округляются.
 */

import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import {
  PrecisionScoreBlock,
  type PrecisionScoreValue,
} from './PrecisionScoreBlock';

type ToneCase = {
  score: PrecisionScoreValue;
  tone: 'emerald' | 'lime' | 'amber' | 'orange' | 'red';
};

const TONES: ToneCase[] = [
  { score: 5, tone: 'emerald' },
  { score: 4, tone: 'lime' },
  { score: 3, tone: 'amber' },
  { score: 2, tone: 'orange' },
  { score: 1, tone: 'red' },
];

describe('<PrecisionScoreBlock>', () => {
  it.each(TONES)(
    'score=$score → $tone, заполнено ровно $score звёзд',
    ({ score, tone }) => {
      renderWithProviders(<PrecisionScoreBlock score={score} scorePct={50} />);

      const block = screen.getByTestId('precision-score-block');
      expect(block.getAttribute('data-score')).toBe(String(score));
      expect(block.getAttribute('data-tone')).toBe(tone);
      expect(block.className).toContain(`precision-score-block--${tone}`);

      const stars = screen
        .getByTestId('precision-score-block-stars')
        .querySelectorAll('svg');
      expect(stars).toHaveLength(5);

      let filled = 0;
      let empty = 0;
      stars.forEach((s) => {
        if (s.getAttribute('data-filled') === 'true') filled += 1;
        else empty += 1;
      });
      expect(filled).toBe(score);
      expect(empty).toBe(5 - score);
    },
  );

  it('accuracy% выводится в строку (целое число) и зажимается в [0..100]', () => {
    const { rerender } = renderWithProviders(
      <PrecisionScoreBlock score={3} scorePct={87.4} />,
    );
    expect(
      screen.getByTestId('precision-score-block-accuracy').textContent,
    ).toContain('87');

    rerender(<PrecisionScoreBlock score={3} scorePct={150} />);
    expect(
      screen.getByTestId('precision-score-block-accuracy').textContent,
    ).toContain('100');

    rerender(<PrecisionScoreBlock score={3} scorePct={-10} />);
    expect(
      screen.getByTestId('precision-score-block-accuracy').textContent,
    ).toContain('0');
  });

  it('интерпретация различается по score', () => {
    const { rerender } = renderWithProviders(
      <PrecisionScoreBlock score={5} scorePct={95} />,
    );
    const text5 = screen
      .getByTestId('precision-score-block-interpretation')
      .textContent?.trim();
    expect(text5).toBeTruthy();

    rerender(<PrecisionScoreBlock score={1} scorePct={20} />);
    const text1 = screen
      .getByTestId('precision-score-block-interpretation')
      .textContent?.trim();
    expect(text1).toBeTruthy();
    expect(text1).not.toBe(text5);
  });

  it('score=3.4 округляется до 3; score=10 зажимается до 5; score=0 → 1', () => {
    const { rerender } = renderWithProviders(
      <PrecisionScoreBlock score={3.4} scorePct={50} />,
    );
    expect(
      screen.getByTestId('precision-score-block').getAttribute('data-score'),
    ).toBe('3');

    rerender(<PrecisionScoreBlock score={10} scorePct={50} />);
    expect(
      screen.getByTestId('precision-score-block').getAttribute('data-score'),
    ).toBe('5');

    rerender(<PrecisionScoreBlock score={0} scorePct={50} />);
    expect(
      screen.getByTestId('precision-score-block').getAttribute('data-score'),
    ).toBe('1');
  });

  it('aria-label содержит "{score} out of 5"', () => {
    renderWithProviders(<PrecisionScoreBlock score={4} scorePct={70} />);
    const stars = screen.getByTestId('precision-score-block-stars');
    expect(stars.getAttribute('aria-label')).toContain('4');
    expect(stars.getAttribute('aria-label')).toContain('5');
  });

  /**
   * KS-3166 (ADR-070 UI): универсальный набор interpretation без
   * дифференциации по objective. KS-3165 откатил — пользователь
   * запросил единый нейтральный текст «оценка позиции» / «решено»
   * для обоих жанров. Prop `objective` снят с компонента.
   */
  describe('KS-3166 — universal interpretation (no objective branching)', () => {
    it('score=5 → нейтральный текст без «advantage»/«draw»/«ничья»', () => {
      renderWithProviders(<PrecisionScoreBlock score={5} scorePct={95} />);
      const text = screen
        .getByTestId('precision-score-block-interpretation')
        .textContent ?? '';
      // EN fallback: «Flawless solution.»
      expect(text).toMatch(/flawless|идеальное/i);
      expect(text).not.toMatch(/draw|ничь/i);
      expect(text).not.toMatch(/advantage|преимущ/i);
    });

    it('score=2 → «position evaluation wavered», нет «advantage wavered» / «draw wavered»', () => {
      renderWithProviders(<PrecisionScoreBlock score={2} scorePct={45} />);
      const text = screen
        .getByTestId('precision-score-block-interpretation')
        .textContent ?? '';
      expect(text).toMatch(/position evaluation wavered|Оценка позиции поколебалась/i);
      expect(text).not.toMatch(/advantage wavered|Преимущество поколебалось/i);
      expect(text).not.toMatch(/draw wavered|Ничья поколебалась/i);
    });
  });

  describe('null-state (KS-3003)', () => {
    it('score=null → блок в нейтральной палитре, "—" вместо звёзд', () => {
      renderWithProviders(<PrecisionScoreBlock score={null} scorePct={null} />);
      const block = screen.getByTestId('precision-score-block');
      expect(block.getAttribute('data-tone')).toBe('unavailable');
      expect(block.className).toContain('precision-score-block--unavailable');
      // Нет SVG-звёзд — только тире.
      expect(
        screen
          .getByTestId('precision-score-block-stars')
          .querySelector('svg'),
      ).toBeNull();
      expect(screen.getByTestId('precision-score-block-dash').textContent).toBe(
        '—',
      );
    });

    it('scorePct=null (а score есть) тоже даёт null-state', () => {
      renderWithProviders(<PrecisionScoreBlock score={3} scorePct={null} />);
      expect(
        screen
          .getByTestId('precision-score-block')
          .getAttribute('data-tone'),
      ).toBe('unavailable');
    });

    it('null-state показывает подпись "Score unavailable"', () => {
      renderWithProviders(<PrecisionScoreBlock score={null} scorePct={null} />);
      expect(
        screen.getByTestId('precision-score-block-accuracy').textContent,
      ).toContain('Score unavailable');
    });
  });

  /**
   * KS-3248 (ADR-076 §7 F3): рендер по матрице 5×2 от backend.
   */
  describe('verdictKey + objectiveAchieved (KS-3248)', () => {
    it('verdictKey=flawless → "Flawless solution"', () => {
      renderWithProviders(
        <PrecisionScoreBlock score={5} scorePct={97} verdictKey="flawless" />,
      );
      expect(
        screen.getByTestId('precision-score-block-interpretation').textContent,
      ).toMatch(/Flawless solution/);
      expect(
        screen
          .getByTestId('precision-score-block')
          .getAttribute('data-verdict-key'),
      ).toBe('flawless');
    });

    it('verdictKey=with-blunders → "Goal achieved, but with blunders"', () => {
      renderWithProviders(
        <PrecisionScoreBlock
          score={1}
          scorePct={20}
          verdictKey="with-blunders"
        />,
      );
      expect(
        screen.getByTestId('precision-score-block-interpretation').textContent,
      ).toMatch(/with blunders/);
    });

    it('verdictKey=goal-missed-mistakes → "Goal not reached, mistakes were made"', () => {
      renderWithProviders(
        <PrecisionScoreBlock
          score={2}
          scorePct={40}
          verdictKey="goal-missed-mistakes"
        />,
      );
      expect(
        screen.getByTestId('precision-score-block-interpretation').textContent,
      ).toMatch(/Goal not reached, mistakes were made/);
    });

    it('без verdictKey + objectiveAchieved=true → computeVerdictKey(score,true)', () => {
      // score=4 + achieved=true → 'confident'.
      renderWithProviders(
        <PrecisionScoreBlock
          score={4}
          scorePct={85}
          objectiveAchieved={true}
        />,
      );
      const block = screen.getByTestId('precision-score-block');
      expect(block.getAttribute('data-verdict-key')).toBe('confident');
      expect(block.getAttribute('data-objective-achieved')).toBe('true');
      expect(
        screen.getByTestId('precision-score-block-interpretation').textContent,
      ).toMatch(/Confident solution/);
    });

    it('без verdictKey + objectiveAchieved=false + score=2 → goal-missed-mistakes', () => {
      renderWithProviders(
        <PrecisionScoreBlock
          score={2}
          scorePct={40}
          objectiveAchieved={false}
        />,
      );
      const block = screen.getByTestId('precision-score-block');
      expect(block.getAttribute('data-verdict-key')).toBe('goal-missed-mistakes');
      expect(block.getAttribute('data-objective-achieved')).toBe('false');
    });

    it('без verdictKey и без objectiveAchieved → fallback на старый interpretation', () => {
      renderWithProviders(<PrecisionScoreBlock score={3} scorePct={60} />);
      const block = screen.getByTestId('precision-score-block');
      expect(block.getAttribute('data-verdict-key')).toBe('');
      expect(block.getAttribute('data-objective-achieved')).toBe('');
      expect(
        screen.getByTestId('precision-score-block-interpretation').textContent,
      ).toMatch(/Solved, but with noticeable mistakes/);
    });

    it('objective=convertAdvantage + achieved=true → подзаголовок "Advantage converted"', () => {
      renderWithProviders(
        <PrecisionScoreBlock
          score={5}
          scorePct={95}
          objective="convertAdvantage"
          objectiveAchieved={true}
        />,
      );
      expect(
        screen.getByTestId('precision-score-block-subtitle').textContent,
      ).toMatch(/Advantage converted/);
    });

    it('objective=saveEquality + achieved=false → подзаголовок "Equality not held"', () => {
      renderWithProviders(
        <PrecisionScoreBlock
          score={1}
          scorePct={20}
          objective="saveEquality"
          objectiveAchieved={false}
        />,
      );
      expect(
        screen.getByTestId('precision-score-block-subtitle').textContent,
      ).toMatch(/Equality not held/);
    });

    it('objective=null или objectiveAchieved=null → подзаголовок не рисуется', () => {
      renderWithProviders(
        <PrecisionScoreBlock
          score={3}
          scorePct={60}
          objective={null}
          objectiveAchieved={true}
        />,
      );
      expect(
        screen.queryByTestId('precision-score-block-subtitle'),
      ).toBeNull();
    });
  });
});
