/**
 * KS-4206 dev-only песочница: рендерит `.broadcasts-finished-toggle`
 * во всех состояниях (нормальное / hover / focus / active / expanded)
 * для приёмочных скриншотов светлой/тёмной темы.
 * Доступ: `/__dev/broadcasts-finished-toggle` (роут добавлен в App.tsx).
 *
 * Песочница нужна, потому что секция «Завершённые (62)» появляется на
 * `/broadcasts` только когда backend отдаёт finished-трансляции; без
 * данных проверить стили нельзя.
 */
import { useState } from 'react';

const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
  { key: 'active', label: 'Active' },
  { key: 'expanded', label: 'Expanded' },
] as const;

type Theme = 'dark' | 'light';

export default function BroadcastsFinishedTogglePreviewPage() {
  const [theme, setTheme] = useState<Theme>('dark');

  return (
    <div
      data-theme={theme}
      style={{
        minHeight: '100vh',
        padding: 32,
        background: 'var(--bg-canvas)',
        color: 'var(--text-primary)',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          alignItems: 'center',
          marginBottom: 24,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          KS-4206 preview · theme:
        </span>
        {(['dark', 'light'] as Theme[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTheme(t)}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--border-mid)',
              background:
                theme === t ? 'var(--accent-primary)' : 'transparent',
              color:
                theme === t ? 'var(--text-on-accent)' : 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: 12,
              textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      <h2 style={{ margin: '0 0 18px', fontSize: 16 }}>
        .broadcasts-finished-toggle — состояния
      </h2>

      <table
        style={{
          borderCollapse: 'collapse',
          width: '100%',
          maxWidth: 720,
          fontSize: 14,
        }}
      >
        <thead>
          <tr>
            <th
              style={{
                textAlign: 'left',
                padding: '8px 12px',
                borderBottom: '1px solid var(--border-subtle)',
                color: 'var(--text-muted)',
                fontWeight: 600,
                fontSize: 12,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Состояние
            </th>
            <th
              style={{
                textAlign: 'left',
                padding: '8px 12px',
                borderBottom: '1px solid var(--border-subtle)',
                color: 'var(--text-muted)',
                fontWeight: 600,
                fontSize: 12,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Кнопка
            </th>
          </tr>
        </thead>
        <tbody>
          {STATES.map((s) => {
            const expanded = s.key === 'expanded';
            const dataTestId = `finished-toggle-${s.key}`;
            return (
              <tr key={s.key}>
                <td
                  style={{
                    padding: '14px 12px',
                    borderBottom: '1px solid var(--border-subtle)',
                    color: 'var(--text-secondary)',
                    verticalAlign: 'middle',
                  }}
                >
                  {s.label}
                </td>
                <td
                  style={{
                    padding: '14px 12px',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <h2 className="broadcasts-finished-header">
                    <button
                      type="button"
                      className={`broadcasts-finished-toggle pf-${s.key}`}
                      aria-expanded={expanded}
                      data-testid={dataTestId}
                    >
                      <span>Завершённые</span>
                      <span className="broadcasts-finished-count">(62)</span>
                      <span
                        className="broadcasts-finished-caret"
                        aria-hidden="true"
                      >
                        {expanded ? '▴' : '▾'}
                      </span>
                    </button>
                  </h2>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Эмуляция hover/focus/active вне курсора — для статических
          скриншотов. Поднимаем приоритет через :where(.pf-…), чтобы
          специфичность была минимальной и не перебивала боевые
          селекторы при реальном взаимодействии. */}
      <style>{`
        .pf-hover { background: var(--ov-white-05) !important; border-color: var(--border-subtle) !important; color: var(--text-primary) !important; }
        .pf-focus { background: var(--ov-white-05) !important; border-color: var(--accent-primary) !important; box-shadow: 0 0 0 2px var(--accent-soft) !important; color: var(--text-primary) !important; outline: none; }
        .pf-active { background: var(--accent-soft) !important; border-color: var(--accent-primary) !important; color: var(--accent-primary) !important; }
      `}</style>
    </div>
  );
}
