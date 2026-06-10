/**
 * KS-4047. Единый список «Доступ учеников к инструментам» в модальных
 * окнах настроек лекции (`CreateLectureModal`, `LectureSettingsModal`,
 * `ScheduleLectureModal`).
 *
 * До этого тикета список был непоследовательным:
 *  - часть пунктов не соответствовала реальным блокам интерфейса
 *    (`analyze_game`, `generate_puzzle`, `find_by_position` — это
 *    «действия в меню», а не панели правой колонки анализа);
 *  - стиль названий разный («Движок» / «Скрыть метрики у учеников»);
 *  - семантика для метрик инвертирована (галочка = «скрыть»).
 *
 * Новый список — 4 пункта, соответствующих реальным блокам правой
 * колонки `AnalysisSidebar`:
 *  1. **ИИ** (AI-комментарий) — `disabledTools.includes('ai_comment')`.
 *  2. **Движок** (Stockfish) — `disabledTools.includes('engine')`.
 *  3. **База партий** — `disabledTools.includes('book')`.
 *  4. **Метрики** (KS-4033) — `hideMetricsTab=true`.
 *
 * Пятый пункт «Ходы» из описания KS-4047 пока не добавлен — в enum
 * `LectureDisabledTool` (`packages/shared`) идентификатора `moves` нет,
 * а серверная валидация whitelist'ом не пропустит. Расширение контракта
 * — отдельная задача backend.
 *
 * Семантика единая: галочка стоит → блок виден ученику. Маппинг
 * UI → DTO:
 *  - снятая «ИИ»          → `disabledTools.push('ai_comment')`
 *  - снятая «Движок»      → `disabledTools.push('engine')`
 *  - снятая «База партий» → `disabledTools.push('book')`
 *  - снятая «Метрики»     → `hideMetricsTab = true`
 *
 * Контракт `LectureDisabledTool` / `hideMetricsTab` НЕ трогаем — это
 * запрет из описания задачи. Старые значения enum
 * (`analyze_game`/`generate_puzzle`/`find_by_position`) остаются в
 * `disabledTools` через `extraDisabledTools` для совместимости с
 * лекциями, созданными до KS-4047.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { LectureDisabledTool } from '@kingside/shared';

export interface StudentVisibilityState {
  disabledTools: LectureDisabledTool[];
  hideMetricsTab: boolean;
}

export interface StudentVisibilityChecklistProps {
  value: StudentVisibilityState;
  onChange: (next: StudentVisibilityState) => void;
  /** Опционально: тренер не может править (например, идёт сохранение). */
  disabled?: boolean;
  /** `data-testid` префикс. По умолчанию `student-visibility`. */
  testIdPrefix?: string;
}

/** Описание одного пункта списка. */
interface VisibilityItem {
  key: 'ai' | 'engine' | 'book' | 'metrics';
  labelI18nKey: string;
  /** Соответствие DTO: либо id из `LectureDisabledTool`, либо специальное поле `hideMetricsTab`. */
  binding:
    | { kind: 'tool'; tool: LectureDisabledTool }
    | { kind: 'metrics' };
}

/**
 * Порядок — как в правой колонке `AnalysisSidebar` (engine → book → ai →
 * metrics), но «ИИ» ставим первым по запросу пользователя «однотипно,
 * короткие названия» — короче всего «ИИ», логично начать с него.
 */
const ITEMS: ReadonlyArray<VisibilityItem> = [
  {
    key: 'ai',
    labelI18nKey: 'studentVisibility.items.ai',
    binding: { kind: 'tool', tool: 'ai_comment' },
  },
  {
    key: 'engine',
    labelI18nKey: 'studentVisibility.items.engine',
    binding: { kind: 'tool', tool: 'engine' },
  },
  {
    key: 'book',
    labelI18nKey: 'studentVisibility.items.book',
    binding: { kind: 'tool', tool: 'book' },
  },
  {
    key: 'metrics',
    labelI18nKey: 'studentVisibility.items.metrics',
    binding: { kind: 'metrics' },
  },
];

/** Старые id, не показываемые в UI после KS-4047. Сохраняем в `disabledTools` без правки. */
const DEPRECATED_TOOL_IDS: ReadonlySet<LectureDisabledTool> = new Set([
  'analyze_game',
  'generate_puzzle',
  'find_by_position',
]);

function isVisible(value: StudentVisibilityState, item: VisibilityItem): boolean {
  if (item.binding.kind === 'metrics') return !value.hideMetricsTab;
  return !value.disabledTools.includes(item.binding.tool);
}

function applyChange(
  value: StudentVisibilityState,
  item: VisibilityItem,
  visible: boolean,
): StudentVisibilityState {
  if (item.binding.kind === 'metrics') {
    return { ...value, hideMetricsTab: !visible };
  }
  const tool = item.binding.tool;
  const set = new Set(value.disabledTools);
  if (visible) set.delete(tool);
  else set.add(tool);
  return { ...value, disabledTools: Array.from(set) };
}

export function StudentVisibilityChecklist({
  value,
  onChange,
  disabled = false,
  testIdPrefix = 'student-visibility',
}: StudentVisibilityChecklistProps) {
  const { t } = useTranslation();
  // Чтобы deprecated id (`analyze_game` и т.п.) не потерялись при
  // сохранении — они никогда не показываются в UI, но при апдейте
  // `disabledTools` остаются в массиве (сохраняем как есть).
  // Реализовано естественным образом: applyChange меняет только один
  // tool из 3 актуальных, остальные значения массива не трогает.
  void DEPRECATED_TOOL_IDS;
  const rows = useMemo(
    () =>
      ITEMS.map((item) => ({
        item,
        visible: isVisible(value, item),
      })),
    [value],
  );
  return (
    <div
      className="student-visibility-checklist"
      data-testid={testIdPrefix}
      role="group"
      aria-label={t(
        'studentVisibility.sectionLabel',
        'What students see',
      )}
    >
      {rows.map(({ item, visible }) => (
        <label
          key={item.key}
          htmlFor={`${testIdPrefix}-${item.key}`}
          className="student-visibility-checklist__row"
          data-disabled={disabled ? 'true' : 'false'}
        >
          <input
            id={`${testIdPrefix}-${item.key}`}
            type="checkbox"
            checked={visible}
            onChange={(e) => onChange(applyChange(value, item, e.target.checked))}
            disabled={disabled}
            data-testid={`${testIdPrefix}-${item.key}`}
          />
          <span>{t(item.labelI18nKey)}</span>
        </label>
      ))}
    </div>
  );
}
