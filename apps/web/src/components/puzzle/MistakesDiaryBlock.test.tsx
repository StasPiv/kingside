/**
 * KS-2554: блок «Слабые темы» скрыт целиком (компонент возвращает null).
 * Полное покрытие старого UI — в git history (последний живой коммит —
 * KS-2496). Здесь — только smoke-тест, что компонент не падает и
 * ничего не рендерит.
 */
import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import { MistakesDiaryBlock } from './MistakesDiaryBlock';

describe('<MistakesDiaryBlock> KS-2554', () => {
  it('возвращает null (UI скрыт)', () => {
    const { container } = renderWithProviders(<MistakesDiaryBlock />);
    expect(container).toBeEmptyDOMElement();
  });
});
