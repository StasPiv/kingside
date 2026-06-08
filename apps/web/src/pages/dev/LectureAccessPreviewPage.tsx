/**
 * KS-3982 dev-only песочница: рендерит разметку `LectureSettingsModal`
 * + `LectureAccessPanel` со статическими данными для приёмочных
 * скриншотов оболочки модалки/выдвижного листа.
 *
 * Доступ: `/__dev/lecture-access` (роут в `App.tsx`).
 *
 * Демонстрирует:
 *  - три вкладки модалки (General / Access / Tools) с подсветкой
 *    активной;
 *  - на вкладке Access — `LectureAccessPanel` (три варианта
 *    доступа + список участников);
 *  - оболочку модалки с заголовком, кнопками «Отмена»/«Сохранить»;
 *  - на узком экране — выдвижной лист снизу с ручкой-индикатором.
 */
import { useState } from 'react';

type Visibility = 'public' | 'unlisted' | 'restricted';
type Tab = 'main' | 'access' | 'tools';

interface Grant {
  id: string;
  username: string;
  displayName: string;
}

const GRANTS: Grant[] = [
  { id: 'g1', username: 'anna_p', displayName: 'Анна Петрова' },
  { id: 'g2', username: 'maxim_v', displayName: 'Максим Волков' },
  { id: 'g3', username: 'igor_k', displayName: 'Игорь Карпов' },
  { id: 'g4', username: 'olga_m', displayName: 'Ольга Морозова' },
];

const VIS_OPTIONS: ReadonlyArray<{
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

const TOOLS = [
  { key: 'analysis', label: 'Engine analysis' },
  { key: 'arrows', label: 'Arrows & highlights' },
  { key: 'chat', label: 'Chat' },
  { key: 'questions', label: 'Questions in chat' },
];

const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: 'main', label: 'General' },
  { value: 'access', label: 'Access' },
  { value: 'tools', label: 'Tools' },
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
          {VIS_OPTIONS.map((opt) => {
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
            className="lecture-modal__input"
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
  const [tab, setTab] = useState<Tab>('access');
  const [visibility, setVisibility] = useState<Visibility>('restricted');
  const [title, setTitle] = useState('Защита Каро-Канн: главные линии');
  const [description, setDescription] = useState(
    'Разбираем тонкости главных линий за обе стороны.',
  );
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    analysis: true,
    arrows: true,
    chat: true,
    questions: false,
  });

  return (
    <div className="lecture-modal-overlay">
      <div
        className="lecture-modal"
        role="dialog"
        aria-modal="true"
        data-active-tab={tab}
      >
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

        <div role="tablist" className="lecture-modal__tablist">
          {TABS.map((opt) => {
            const active = opt.value === tab;
            return (
              <button
                key={opt.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(opt.value)}
                data-testid={`landing-preview-switch-${opt.value}`}
                className={
                  'lecture-modal__tab' +
                  (active ? ' lecture-modal__tab--active' : '')
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <div className="lecture-modal__body">
          {tab === 'main' && (
            <div>
              <div className="lecture-modal__field">
                <label className="lecture-modal__field-label">Title</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  className="lecture-modal__input"
                />
              </div>
              <div className="lecture-modal__field">
                <label className="lecture-modal__field-label">
                  Description
                  <span className="lecture-modal__field-optional">
                    optional
                  </span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  className="lecture-modal__textarea"
                />
              </div>
            </div>
          )}
          {tab === 'access' && (
            <AccessPanel
              visibility={visibility}
              setVisibility={setVisibility}
            />
          )}
          {tab === 'tools' && (
            <div>
              <p className="lecture-modal__tools-section-title">
                Student tools access
              </p>
              <div className="lecture-modal__tools-list">
                {TOOLS.map((tool) => (
                  <label key={tool.key} className="lecture-modal__tool-row">
                    <input
                      type="checkbox"
                      checked={enabled[tool.key]}
                      onChange={() =>
                        setEnabled((p) => ({ ...p, [tool.key]: !p[tool.key] }))
                      }
                    />
                    <span>{tool.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="lecture-modal__footer">
          <button
            type="button"
            className="lecture-modal__btn lecture-modal__btn--ghost"
          >
            Cancel
          </button>
          <button
            type="button"
            className="lecture-modal__btn lecture-modal__btn--primary"
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
