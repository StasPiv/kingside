import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * `OwnerActionsMenu` — dropdown `[⋯]` с действиями владельца курса
 * (KS-1848 §3.6, KS-1855 / FE-R7).
 *
 * Пункты:
 *  - «Просмотр» → navigate на публичный URL курса
 *  - «Копировать ссылку» → clipboard API
 *  - «Удалить курс» → открывает `<DeleteCourseDialog>` (родитель
 *    управляет его open-стейтом)
 *
 * Публикация через `PublishToggle` отдельно — в шапке, не в этом меню
 * (ADR-026 §3.6 — публикация должна быть заметной, не прятаться в
 * dropdown).
 *
 * Клик вне меню закрывает его. Esc тоже закрывает.
 */

interface OwnerActionsMenuProps {
  onView: () => void;
  onCopyLink: () => void;
  onDelete: () => void;
}

export function OwnerActionsMenu({
  onView,
  onCopyLink,
  onDelete,
}: OwnerActionsMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        wrapRef.current &&
        !wrapRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const call = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div
      className="owner-actions-menu"
      data-testid="owner-actions-menu"
      ref={wrapRef}
    >
      <button
        type="button"
        className="owner-actions-menu__trigger"
        data-testid="owner-actions-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <ul
          className="owner-actions-menu__dropdown"
          role="menu"
          data-testid="owner-actions-menu-dropdown"
        >
          <li>
            <button
              type="button"
              role="menuitem"
              data-testid="owner-actions-menu-view"
              onClick={call(onView)}
            >
              {t('lessons.my.open', 'Open')}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              data-testid="owner-actions-menu-copy-link"
              onClick={call(onCopyLink)}
            >
              {t('lessons.my.copyLink', 'Copy link')}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              className="owner-actions-menu__delete"
              data-testid="owner-actions-menu-delete"
              onClick={call(onDelete)}
            >
              {t('lessons.my.delete', 'Delete')}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
