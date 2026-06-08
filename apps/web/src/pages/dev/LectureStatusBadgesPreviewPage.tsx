/**
 * KS-3984 / ADR-119 §8 эпик E. Dev-only песочница для визуальной
 * проверки бейджей статусов лекций. Чисто презентационная страница
 * без логики — рендерит все 4 статуса (live / scheduled / recorded
 * / cancelled) во всех 3 размерах (sm / base / lg) и в контексте
 * заголовка карточки лекции.
 *
 * Доступ: `/__dev/lecture-status-badges` (роут добавлен в `App.tsx`).
 * Используется для приёмочных скриншотов задачи KS-3984.
 */

const STATUSES = ['live', 'scheduled', 'recorded', 'cancelled'] as const;
const SIZES = ['sm', 'base', 'lg'] as const;

const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = {
  live: 'Live',
  scheduled: 'Scheduled',
  recorded: 'Recorded',
  cancelled: 'Cancelled',
};

function badgeClass(
  status: (typeof STATUSES)[number],
  size: (typeof SIZES)[number],
): string {
  const parts = ['lecture-status-badge', `lecture-status-badge--${status}`];
  if (size !== 'base') parts.push(`lecture-status-badge--${size}`);
  return parts.join(' ');
}

export default function LectureStatusBadgesPreviewPage() {
  return (
    <div
      data-testid="lecture-status-badges-preview"
      style={{
        padding: 24,
        maxWidth: 880,
        margin: '0 auto',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1 style={{ marginBottom: 4 }}>Lecture status badges</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        KS-3984 · ADR-119 §8 эпик E · единая цветовая схема.
      </p>

      {/* Таблица: статус × размер */}
      <h2 style={{ marginTop: 32 }}>Все статусы × размеры</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '120px repeat(3, 1fr)',
          gap: 12,
          alignItems: 'center',
          padding: 16,
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
        }}
      >
        <div />
        {SIZES.map((size) => (
          <div
            key={size}
            style={{
              fontSize: 12,
              opacity: 0.7,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {size}
          </div>
        ))}
        {STATUSES.map((status) => (
          <ContentsRow key={status} status={status} />
        ))}
      </div>

      {/* Бейдж в контексте заголовка карточки лекции */}
      <h2 style={{ marginTop: 32 }}>В контексте карточки лекции</h2>
      <div style={{ display: 'grid', gap: 12 }}>
        {STATUSES.map((status) => (
          <article
            key={status}
            style={{
              padding: 16,
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              background: 'var(--bg-surface)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginBottom: 4,
              }}
            >
              <h3 style={{ margin: 0, fontSize: 16 }}>
                Эндшпиль ладья + пешка против ладьи
              </h3>
              <span
                className={badgeClass(status, 'base')}
                data-testid={`badge-card-${status}`}
              >
                {STATUS_LABEL[status]}
              </span>
            </div>
            <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>
              Тренер: GM Petrov · 24 мая 19:00
            </p>
          </article>
        ))}
      </div>

      {/* Бейдж в контексте крупного заголовка лендинга */}
      <h2 style={{ marginTop: 32 }}>На заголовке лендинга (--lg)</h2>
      <div
        style={{
          padding: 24,
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
          background: 'var(--bg-surface)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 24 }}>
            Защита Каро-Канн: главные линии
          </h1>
          <span
            className={badgeClass('live', 'lg')}
            data-testid="badge-landing-live"
          >
            {STATUS_LABEL.live}
          </span>
        </div>
      </div>
    </div>
  );
}

function ContentsRow({ status }: { status: (typeof STATUSES)[number] }) {
  return (
    <>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          textTransform: 'capitalize',
        }}
      >
        {status}
      </div>
      {SIZES.map((size) => (
        <div key={size}>
          <span
            className={badgeClass(status, size)}
            data-testid={`badge-${status}-${size}`}
          >
            {STATUS_LABEL[status]}
          </span>
        </div>
      ))}
    </>
  );
}
