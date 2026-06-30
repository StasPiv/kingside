import type { ReactElement } from 'react';
import { EVENT_CATALOG } from '@kingside/shared';
import {
  emptyNode,
  type CompareOp,
  type RuleKind,
  type RuleNode,
  type TimeSinceUnit,
  type WhereEntry,
  type WindowUnit,
} from './ruleBuilderModel';

/**
 * KS-4830. Визуальный конструктор правил подсказок. Рекурсивно
 * рендерит дерево узлов; редактирование любого поля поднимается
 * вверх через `onChange(rootNode)`. Сериализация в DSL-JSON — в
 * `ruleBuilderModel.encode()` на стороне формы, чтобы builder сам
 * не знал контракта `rule` для PUT.
 */

interface RuleBuilderProps {
  value: RuleNode;
  onChange: (next: RuleNode) => void;
}

const KIND_LABELS: Record<RuleKind, string> = {
  all: 'AND (all)',
  any: 'OR (any)',
  not: 'NOT',
  page: 'page.matches',
  actorType: 'actorType.equals',
  count: 'count',
  exists: 'exists',
  timeSince: 'timeSince',
};

const ALL_KINDS: ReadonlyArray<RuleKind> = [
  'all',
  'any',
  'not',
  'page',
  'actorType',
  'count',
  'exists',
  'timeSince',
];

const WINDOW_UNIT_LABELS: Record<WindowUnit, string> = {
  windowMin: 'минут',
  windowHours: 'часов',
  windowDays: 'дней',
  sinceDays: 'дней (sinceDays)',
};

const TIME_SINCE_UNIT_LABELS: Record<TimeSinceUnit, string> = {
  gtMin: 'минут',
  gtHours: 'часов',
  gtDays: 'дней',
};

const COMPARE_OP_LABELS: Record<CompareOp, string> = {
  gte: '≥',
  lte: '≤',
  eq: '=',
};

export function RuleBuilder({ value, onChange }: RuleBuilderProps): ReactElement {
  return (
    <div className="rule-builder" data-testid="rule-builder">
      <NodeEditor node={value} onChange={onChange} path="$" />
    </div>
  );
}

interface NodeEditorProps {
  node: RuleNode;
  onChange: (n: RuleNode) => void;
  path: string;
  onRemove?: () => void;
}

function NodeEditor({ node, onChange, path, onRemove }: NodeEditorProps): ReactElement {
  const onKindChange = (kind: RuleKind) => onChange(emptyNode(kind));
  return (
    <div
      className={`rule-node rule-node--${node.kind}`}
      data-testid={`rule-node-${node.kind}`}
    >
      <div className="rule-node__header">
        <select
          value={node.kind}
          onChange={(e) => onKindChange(e.currentTarget.value as RuleKind)}
          data-testid={`rule-node-kind-${path}`}
        >
          {ALL_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        {onRemove && (
          <button
            type="button"
            className="rule-node__remove"
            onClick={onRemove}
            data-testid={`rule-node-remove-${path}`}
          >
            ×
          </button>
        )}
      </div>
      <div className="rule-node__body">
        {renderBody(node, onChange, path)}
      </div>
    </div>
  );
}

function renderBody(
  node: RuleNode,
  onChange: (n: RuleNode) => void,
  path: string,
): ReactElement {
  switch (node.kind) {
    case 'all':
    case 'any':
      return (
        <ChildList
          kind={node.kind}
          children={node.children}
          onChange={(children) => onChange({ ...node, children })}
          path={path}
        />
      );
    case 'not':
      return (
        <NodeEditor
          node={node.child}
          onChange={(child) => onChange({ kind: 'not', child })}
          path={`${path}.not`}
        />
      );
    case 'page':
      return (
        <label className="rule-node__field">
          matches:
          <input
            type="text"
            value={node.matches}
            placeholder="/play/*"
            onChange={(e) => {
              const v = e.currentTarget.value;
              onChange({ kind: 'page', matches: v });
            }}
            data-testid={`rule-page-matches-${path}`}
          />
        </label>
      );
    case 'actorType':
      return (
        <label className="rule-node__field">
          equals:
          <select
            value={node.equals}
            onChange={(e) => {
              const v = e.currentTarget.value as RuleNode['kind'] extends 'actorType'
                ? '' | 'user' | 'guest'
                : never;
              onChange({
                kind: 'actorType',
                equals: v as '' | 'user' | 'guest',
              });
            }}
            data-testid={`rule-actortype-equals-${path}`}
          >
            <option value="">—</option>
            <option value="user">user</option>
            <option value="guest">guest</option>
          </select>
        </label>
      );
    case 'count':
      return (
        <CountEditor node={node} onChange={onChange} path={path} />
      );
    case 'exists':
      return (
        <ExistsEditor node={node} onChange={onChange} path={path} />
      );
    case 'timeSince':
      return (
        <TimeSinceEditor node={node} onChange={onChange} path={path} />
      );
  }
}

function ChildList({
  kind,
  children,
  onChange,
  path,
}: {
  kind: 'all' | 'any';
  children: RuleNode[];
  onChange: (next: RuleNode[]) => void;
  path: string;
}): ReactElement {
  return (
    <div className="rule-node__children">
      {children.map((c, i) => (
        <NodeEditor
          key={i}
          node={c}
          onChange={(next) => {
            const copy = [...children];
            copy[i] = next;
            onChange(copy);
          }}
          path={`${path}.${kind}[${i}]`}
          onRemove={() => onChange(children.filter((_, j) => j !== i))}
        />
      ))}
      <button
        type="button"
        className="rule-node__add"
        onClick={() =>
          onChange([...children, { kind: 'page', matches: '' }])
        }
        data-testid={`rule-node-add-${path}`}
      >
        + добавить условие
      </button>
    </div>
  );
}

function EventSelect({
  value,
  onChange,
  testid,
}: {
  value: string;
  onChange: (v: string) => void;
  testid: string;
}): ReactElement {
  return (
    <label className="rule-node__field">
      event:
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        data-testid={testid}
      >
        <option value="">— выберите —</option>
        {EVENT_CATALOG.map((m) => (
          <option key={m.type} value={m.type}>
            {m.type} ({m.category})
          </option>
        ))}
      </select>
    </label>
  );
}

function WhereEditor({
  entries,
  onChange,
  testid,
}: {
  entries: WhereEntry[];
  onChange: (next: WhereEntry[]) => void;
  testid: string;
}): ReactElement {
  return (
    <div className="rule-node__where" data-testid={testid}>
      <div className="rule-node__where-label">where (payload):</div>
      {entries.map((e, i) => (
        <div key={i} className="rule-node__where-row">
          <input
            type="text"
            value={e.key}
            placeholder="key (напр. result)"
            onChange={(ev) => {
              const v = ev.currentTarget.value;
              const copy = [...entries];
              copy[i] = { ...copy[i], key: v };
              onChange(copy);
            }}
            data-testid={`${testid}-key-${i}`}
          />
          <input
            type="text"
            value={e.value}
            placeholder="value (напр. loss)"
            onChange={(ev) => {
              const v = ev.currentTarget.value;
              const copy = [...entries];
              copy[i] = { ...copy[i], value: v };
              onChange(copy);
            }}
            data-testid={`${testid}-value-${i}`}
          />
          <button
            type="button"
            onClick={() => onChange(entries.filter((_, j) => j !== i))}
            data-testid={`${testid}-remove-${i}`}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...entries, { key: '', value: '' }])}
        data-testid={`${testid}-add`}
      >
        + payload-фильтр
      </button>
    </div>
  );
}

function WindowEditor({
  unit,
  value,
  onChange,
  testid,
}: {
  unit: WindowUnit;
  value: string;
  onChange: (unit: WindowUnit, value: string) => void;
  testid: string;
}): ReactElement {
  return (
    <div className="rule-node__field rule-node__field--inline">
      <label>
        окно:
        <select
          value={unit}
          onChange={(e) => onChange(e.currentTarget.value as WindowUnit, value)}
          data-testid={`${testid}-unit`}
        >
          {(Object.keys(WINDOW_UNIT_LABELS) as WindowUnit[]).map((u) => (
            <option key={u} value={u}>
              {WINDOW_UNIT_LABELS[u]}
            </option>
          ))}
        </select>
      </label>
      <input
        type="number"
        min="1"
        value={value}
        onChange={(e) => onChange(unit, e.currentTarget.value)}
        data-testid={`${testid}-value`}
      />
    </div>
  );
}

function CountEditor({
  node,
  onChange,
  path,
}: {
  node: Extract<RuleNode, { kind: 'count' }>;
  onChange: (n: RuleNode) => void;
  path: string;
}): ReactElement {
  return (
    <>
      <EventSelect
        value={node.event}
        onChange={(event) => onChange({ ...node, event })}
        testid={`rule-count-event-${path}`}
      />
      <WhereEditor
        entries={node.where}
        onChange={(where) => onChange({ ...node, where })}
        testid={`rule-count-where-${path}`}
      />
      <WindowEditor
        unit={node.windowUnit}
        value={node.windowValue}
        onChange={(windowUnit, windowValue) =>
          onChange({ ...node, windowUnit, windowValue })
        }
        testid={`rule-count-window-${path}`}
      />
      <div className="rule-node__field rule-node__field--inline">
        <label>
          сравнение:
          <select
            value={node.op}
            onChange={(e) =>
              onChange({ ...node, op: e.currentTarget.value as CompareOp })
            }
            data-testid={`rule-count-op-${path}`}
          >
            {(Object.keys(COMPARE_OP_LABELS) as CompareOp[]).map((o) => (
              <option key={o} value={o}>
                {COMPARE_OP_LABELS[o]} ({o})
              </option>
            ))}
          </select>
        </label>
        <input
          type="number"
          value={node.opValue}
          onChange={(e) => {
            const v = e.currentTarget.value;
            onChange({ ...node, opValue: v });
          }}
          data-testid={`rule-count-op-value-${path}`}
        />
      </div>
    </>
  );
}

function ExistsEditor({
  node,
  onChange,
  path,
}: {
  node: Extract<RuleNode, { kind: 'exists' }>;
  onChange: (n: RuleNode) => void;
  path: string;
}): ReactElement {
  return (
    <>
      <EventSelect
        value={node.event}
        onChange={(event) => onChange({ ...node, event })}
        testid={`rule-exists-event-${path}`}
      />
      <WhereEditor
        entries={node.where}
        onChange={(where) => onChange({ ...node, where })}
        testid={`rule-exists-where-${path}`}
      />
      <WindowEditor
        unit={node.windowUnit}
        value={node.windowValue}
        onChange={(windowUnit, windowValue) =>
          onChange({ ...node, windowUnit, windowValue })
        }
        testid={`rule-exists-window-${path}`}
      />
    </>
  );
}

function TimeSinceEditor({
  node,
  onChange,
  path,
}: {
  node: Extract<RuleNode, { kind: 'timeSince' }>;
  onChange: (n: RuleNode) => void;
  path: string;
}): ReactElement {
  return (
    <>
      <EventSelect
        value={node.event}
        onChange={(event) => onChange({ ...node, event })}
        testid={`rule-timesince-event-${path}`}
      />
      <div className="rule-node__field rule-node__field--inline">
        <label>
          прошло больше чем:
          <select
            value={node.sinceUnit}
            onChange={(e) =>
              onChange({
                ...node,
                sinceUnit: e.currentTarget.value as TimeSinceUnit,
              })
            }
            data-testid={`rule-timesince-unit-${path}`}
          >
            {(Object.keys(TIME_SINCE_UNIT_LABELS) as TimeSinceUnit[]).map(
              (u) => (
                <option key={u} value={u}>
                  {TIME_SINCE_UNIT_LABELS[u]}
                </option>
              ),
            )}
          </select>
        </label>
        <input
          type="number"
          min="1"
          value={node.sinceValue}
          onChange={(e) => {
            const v = e.currentTarget.value;
            onChange({ ...node, sinceValue: v });
          }}
          data-testid={`rule-timesince-value-${path}`}
        />
      </div>
    </>
  );
}
