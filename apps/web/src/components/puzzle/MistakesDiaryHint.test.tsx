/**
 * KS-2554: compact-блок «Слабые темы» под доской скрыт (компонент
 * возвращает null). Полное покрытие — в git history (KS-2496).
 */
import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import { MistakesDiaryHint } from './MistakesDiaryHint';

describe('<MistakesDiaryHint> KS-2554', () => {
  it('возвращает null (UI скрыт)', () => {
    const { container } = renderWithProviders(<MistakesDiaryHint />);
    expect(container).toBeEmptyDOMElement();
  });
});
