/**
 * KS-3980 dev-only песочница: рендерит разметку `MyLecturesPage`
 * (без API/сетевых вызовов) со статическими данными для приёмочных
 * скриншотов адаптива и фильтров.
 *
 * Доступ: `/__dev/my-lectures` (роут добавлен в `App.tsx`).
 *
 * Демонстрирует:
 *  - desktop grid-таблицу (≥720px) и mobile-карточки (<720px);
 *  - segment-control для фильтров статуса и видимости;
 *  - значок статуса в каждой строке;
 *  - открытое контекстное меню `⋮` для первой строки.
 */
import { useState } from 'react';

type Status = 'live' | 'scheduled' | 'recorded' | 'cancelled';
type Visibility = 'public' | 'unlisted' | 'restricted';

interface Row {
  id: string;
  title: string;
  status: Status;
  visibility: Visibility;
  date: string;
}

const ROWS: Row[] = [
  {
    id: 'a1',
    title: 'Защита Каро-Канн: главные линии',
    status: 'live',
    visibility: 'public',
    date: '24 мая 2026, 19:00',
  },
  {
    id: 'b2',
    title: 'Эндшпиль ладья + пешка против ладьи',
    status: 'scheduled',
    visibility: 'unlisted',
    date: '30 мая 2026, 20:00',
  },
  {
    id: 'c3',
    title: 'Атака на короткую рокировку: модельные партии',
    status: 'recorded',
    visibility: 'public',
    date: '12 апреля 2026',
  },
  {
    id: 'd4',
    title: 'Урок для группы Б (закрытая лекция)',
    status: 'scheduled',
    visibility: 'restricted',
    date: '5 июня 2026, 18:30',
  },
  {
    id: 'e5',
    title: 'Староиндийская защита: разбор партий',
    status: 'cancelled',
    visibility: 'public',
    date: '3 мая 2026',
  },
];

type StatusFilter = Status | 'all';
type VisibilityFilter = Visibility | 'all';

const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'live', label: 'Live' },
  { value: 'recorded', label: 'Recorded' },
  { value: 'cancelled', label: 'Cancelled' },
];

const VISIBILITY_OPTIONS: ReadonlyArray<{
  value: VisibilityFilter;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'public', label: 'Public' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'restricted', label: 'Restricted' },
];

function badgeClass(status: Status): string {
  return `lecture-status-badge lecture-status-badge--${status} lecture-status-badge--sm`;
}

function badgeText(status: Status): string {
  if (status === 'live') return 'Live';
  if (status === 'scheduled') return 'Scheduled';
  if (status === 'recorded') return 'Recorded';
  return 'Cancelled';
}

export default function MyLecturesPreviewPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [visibilityFilter, setVisibilityFilter] =
    useState<VisibilityFilter>('all');
  const [openMenuId, setOpenMenuId] = useState<string | null>('a1');

  const items = ROWS.filter(
    (r) =>
      (statusFilter === 'all' || r.status === statusFilter) &&
      (visibilityFilter === 'all' || r.visibility === visibilityFilter),
  );

  return (
    <div
      className="my-lectures-page"
      data-testid="my-lectures-page"
      data-mode="coach"
    >
      <h1 className="my-lectures-page__title">My lectures</h1>

      <div className="my-lectures-page__filters">
        <div className="my-lectures-page__filter-group">
          <span className="my-lectures-page__filter-label">Status</span>
          <div
            className="my-lectures-page__segment"
            role="group"
            aria-label="Status"
          >
            {STATUS_OPTIONS.map((opt) => {
              const active = opt.value === statusFilter;
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setStatusFilter(opt.value)}
                  className={
                    'my-lectures-page__segment-btn' +
                    (active ? ' my-lectures-page__segment-btn--active' : '')
                  }
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="my-lectures-page__filter-group">
          <span className="my-lectures-page__filter-label">Visibility</span>
          <div
            className="my-lectures-page__segment"
            role="group"
            aria-label="Visibility"
          >
            {VISIBILITY_OPTIONS.map((opt) => {
              const active = opt.value === visibilityFilter;
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setVisibilityFilter(opt.value)}
                  className={
                    'my-lectures-page__segment-btn' +
                    (active ? ' my-lectures-page__segment-btn--active' : '')
                  }
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
        <span className="my-lectures-page__total">{items.length} total</span>
      </div>

      <ul className="my-lectures-page__list">
        <li className="my-lectures-page__list-head" aria-hidden="true">
          <span>Status</span>
          <span>Title</span>
          <span>Visibility</span>
          <span>Date</span>
          <span />
        </li>
        {items.map((row) => {
          const menuOpen = openMenuId === row.id;
          return (
            <li
              key={row.id}
              className="my-lectures-page__item"
              data-status={row.status}
            >
              <span className="my-lectures-page__cell">
                <span className={badgeClass(row.status)}>
                  {badgeText(row.status)}
                </span>
              </span>
              <span className="my-lectures-page__cell">
                <a href="#" onClick={(e) => e.preventDefault()} className="my-lectures-page__title-link">
                  {row.title}
                </a>
              </span>
              <span className="my-lectures-page__cell my-lectures-page__visibility">
                <span className="my-lectures-page__cell-label">Visibility</span>
                {row.visibility}
              </span>
              <span className="my-lectures-page__cell my-lectures-page__date">
                <span className="my-lectures-page__cell-label">Date</span>
                {row.date}
              </span>
              <div className="my-lectures-page__actions">
                <button
                  type="button"
                  aria-label="Actions"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setOpenMenuId(menuOpen ? null : row.id)}
                  className="my-lectures-page__menu-btn"
                >
                  ⋮
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    className="my-lectures-page__menu-popover"
                    onMouseLeave={() => setOpenMenuId(null)}
                  >
                    <button type="button" role="menuitem" className="my-lectures-page__menu-item">
                      Open
                    </button>
                    {row.status === 'live' && (
                      <button type="button" role="menuitem" className="my-lectures-page__menu-item">
                        End broadcast
                      </button>
                    )}
                    {row.status === 'scheduled' && (
                      <button type="button" role="menuitem" className="my-lectures-page__menu-item">
                        Start
                      </button>
                    )}
                    <button type="button" role="menuitem" className="my-lectures-page__menu-item">
                      Settings
                    </button>
                    <button type="button" role="menuitem" className="my-lectures-page__menu-item">
                      Copy link
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="my-lectures-page__menu-item my-lectures-page__menu-item--danger"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="my-lectures-page__load-more-wrap">
        <button type="button" className="my-lectures-page__load-more">
          Load more
        </button>
      </div>
    </div>
  );
}
