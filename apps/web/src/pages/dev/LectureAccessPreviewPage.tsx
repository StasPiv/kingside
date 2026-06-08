/**
 * KS-3982 dev-only песочница: рендерит разметку `LectureAccessPanel`
 * со статическими данными внутри оболочки модалки/выдвижного листа
 * для приёмочных скриншотов KS-3982.
 *
 * Доступ: `/__dev/lecture-access` (роут в `App.tsx`).
 *
 * Демонстрирует:
 *  - три варианта visibility (public / unlisted / restricted) с
 *    подсветкой выбранного;
 *  - allowlist с участниками для `restricted`;
 *  - оболочку модалки с заголовком и кнопками;
 *  - на mobile — выдвижной лист снизу с ручкой-индикатором.
 */
import { useState } from 'react';

type Visibility = 'public' | 'unlisted' | 'restricted';

interface Grant {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}

const GRANTS: Grant[] = [
  { id: 'g1', username: 'anna_p', displayName: 'Анна Петрова' },
  { id: 'g2', username: 'maxim_v', displayName: 'Максим Волков' },
  { id: 'g3', username: 'igor_k', displayName: 'Игорь Карпов' },
  { id: 'g4', username: 'olga_m', displayName: 'Ольга Морозова' },
];

const OPTIONS: ReadonlyArray<{
  value: Visibility;
  title: string;
  hint: string;
}> = [
  {
    value: 'public',
    title: 'Public',
    hint: 'Anyone with the link can join.',
  },
  {
    value: 'unlisted',
    title: 'Unlisted',
    hint: 'Only people who have the direct link can join.',
  },
  {
    value: 'restricted',
    title: 'Restricted',
    hint: 'Only people you list below can join.',
  },
];

function AccessPanel({
  visibility,
  setVisibility,
}: {
  visibility: Visibility;
  setVisibility: (v: Visibility) => void;
}) {
  return (
    <div
      className="lecture-access-panel"
      data-visibility={visibility}
    >
      <fieldset className="lecture-access-panel__visibility">
        <legend className="lecture-access-panel__legend">
          Who can see this lecture
        </legend>
        <div className="lecture-access-panel__visibility-list">
          {OPTIONS.map((opt) => {
            const active = opt.value === visibility;
            return (
              <label
                key={opt.value}
                className={
                  'lecture-access-panel__option' +
                  (active ? ' lecture-access-panel__option--active' : '')
                }
              >
                <input
                  type="radio"
                  name="vis"
                  checked={active}
                  onChange={() => setVisibility(opt.value)}
                  className="lecture-access-panel__option-radio"
                />
                <span className="lecture-access-panel__option-text">
                  <span className="lecture-access-panel__option-title">
                    {opt.title}
                  </span>
                  <span className="lecture-access-panel__option-hint">
                    {opt.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {visibility === 'restricted' && (
        <section className="lecture-access-panel__allowlist">
          <h3 className="lecture-access-panel__allowlist-heading">
            Who has access
          </h3>
          <input
            placeholder="Search users by username…"
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid var(--border-mid)',
              background: 'var(--bg-input)',
              color: 'var(--text-primary)',
              fontSize: 13,
            }}
          />
          <ul className="lecture-access-panel__chips">
            {GRANTS.map((g) => (
              <li key={g.id} className="lecture-access-panel__chip">
                <span
                  aria-hidden="true"
                  className="lecture-access-panel__chip-avatar-fallback"
                >
                  {g.username.slice(0, 1).toUpperCase()}
                </span>
                <span className="lecture-access-panel__chip-name">
                  {g.displayName}
                </span>
                <button
                  type="button"
                  className="lecture-access-panel__chip-remove"
                  aria-label={`Remove ${g.displayName}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function LectureAccessPreviewPage() {
  const [visibility, setVisibility] = useState<Visibility>('restricted');

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--ov-black-55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
      className="lecture-modal-overlay"
    >
      <div className="lecture-modal">
        <header className="lecture-modal__header">
          <h2 className="lecture-modal__title">Lecture settings</h2>
          <button
            type="button"
            className="lecture-modal__close"
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="lecture-modal__body">
          <AccessPanel
            visibility={visibility}
            setVisibility={setVisibility}
          />
        </div>
        <footer className="lecture-modal__footer">
          <button type="button" className="lecture-modal__btn lecture-modal__btn--ghost">
            Cancel
          </button>
          <button type="button" className="lecture-modal__btn lecture-modal__btn--primary">
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
