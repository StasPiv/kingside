/**
 * KS-4047. Тесты единого списка «Что видят ученики».
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/test-utils';
import type { LectureDisabledTool } from '@kingside/shared';
import {
  StudentVisibilityChecklist,
  type StudentVisibilityState,
} from './StudentVisibilityChecklist';

function defaultState(
  over: Partial<StudentVisibilityState> = {},
): StudentVisibilityState {
  return {
    disabledTools: [],
    hideMetricsTab: false,
    ...over,
  };
}

describe('<StudentVisibilityChecklist> KS-4047', () => {
  it('рендерит ровно 4 пункта в фиксированном порядке (ИИ → Движок → База партий → Метрики)', () => {
    renderWithProviders(
      <StudentVisibilityChecklist
        value={defaultState()}
        onChange={vi.fn()}
      />,
    );
    const ids = [
      'student-visibility-ai',
      'student-visibility-engine',
      'student-visibility-book',
      'student-visibility-metrics',
    ];
    for (const id of ids) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    // Нет мёртвых пунктов.
    expect(screen.queryByTestId('student-visibility-analyze_game')).toBeNull();
    expect(
      screen.queryByTestId('student-visibility-generate_puzzle'),
    ).toBeNull();
    expect(
      screen.queryByTestId('student-visibility-find_by_position'),
    ).toBeNull();
  });

  it('по умолчанию (пустое состояние) все галочки стоят', () => {
    renderWithProviders(
      <StudentVisibilityChecklist
        value={defaultState()}
        onChange={vi.fn()}
      />,
    );
    for (const key of ['ai', 'engine', 'book', 'metrics']) {
      const cb = screen.getByTestId(
        `student-visibility-${key}`,
      ) as HTMLInputElement;
      expect(cb.checked).toBe(true);
    }
  });

  it('hideMetricsTab=true → галочка «Метрики» снята', () => {
    renderWithProviders(
      <StudentVisibilityChecklist
        value={defaultState({ hideMetricsTab: true })}
        onChange={vi.fn()}
      />,
    );
    const cb = screen.getByTestId(
      'student-visibility-metrics',
    ) as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  it('disabledTools.includes("engine") → галочка «Движок» снята', () => {
    renderWithProviders(
      <StudentVisibilityChecklist
        value={defaultState({ disabledTools: ['engine'] })}
        onChange={vi.fn()}
      />,
    );
    const cb = screen.getByTestId(
      'student-visibility-engine',
    ) as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  describe('маппинг UI → DTO', () => {
    it('снятие «Метрики» → hideMetricsTab=true', () => {
      const onChange = vi.fn();
      renderWithProviders(
        <StudentVisibilityChecklist
          value={defaultState()}
          onChange={onChange}
        />,
      );
      fireEvent.click(screen.getByTestId('student-visibility-metrics'));
      expect(onChange).toHaveBeenLastCalledWith({
        disabledTools: [],
        hideMetricsTab: true,
      });
    });

    it('снятие «ИИ» → disabledTools += "ai_comment"', () => {
      const onChange = vi.fn();
      renderWithProviders(
        <StudentVisibilityChecklist
          value={defaultState()}
          onChange={onChange}
        />,
      );
      fireEvent.click(screen.getByTestId('student-visibility-ai'));
      expect(onChange).toHaveBeenLastCalledWith({
        disabledTools: ['ai_comment'],
        hideMetricsTab: false,
      });
    });

    it('повторный клик включает обратно — disabledTools без id', () => {
      const onChange = vi.fn();
      renderWithProviders(
        <StudentVisibilityChecklist
          value={defaultState({ disabledTools: ['engine'] })}
          onChange={onChange}
        />,
      );
      fireEvent.click(screen.getByTestId('student-visibility-engine'));
      expect(onChange).toHaveBeenLastCalledWith({
        disabledTools: [],
        hideMetricsTab: false,
      });
    });

    it('сохраняет старые/deprecated значения disabledTools при правке нового пункта', () => {
      // Лекция уже была создана с `analyze_game` в disabledTools (из
      // старого UI). После KS-4047 этот пункт не показывается, но не
      // должен потеряться при правке других пунктов.
      const onChange = vi.fn();
      const oldDisabled: LectureDisabledTool[] = [
        'analyze_game',
        'generate_puzzle',
      ];
      renderWithProviders(
        <StudentVisibilityChecklist
          value={defaultState({ disabledTools: oldDisabled })}
          onChange={onChange}
        />,
      );
      fireEvent.click(screen.getByTestId('student-visibility-book'));
      const [next] = onChange.mock.calls[0];
      expect(next.disabledTools.sort()).toEqual(
        ['analyze_game', 'book', 'generate_puzzle'].sort(),
      );
      expect(next.hideMetricsTab).toBe(false);
    });
  });
});
