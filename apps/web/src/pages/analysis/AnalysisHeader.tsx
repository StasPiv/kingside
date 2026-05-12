import type { KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { HelpButton } from '../../components/HelpButton';

/**
 * KS-2863 (ADR-060 §10.1 FR1) — извлечённый header `AnalysisPage`.
 *
 * Compositionally замещает inline-JSX из `AnalysisPage` (строки
 * 1337–1383 до рефакторинга): workshop-shortcut + breadcrumbs +
 * inline-edit title. На FR1-этапе компонент чисто-presentational —
 * вся state-логика (`isEditingTitle`, `titleInput`, handlers) живёт
 * в AnalysisPage и пробрасывается через props. Discriminated union
 * по `mode` зарезервирован для будущих FM1-FM5 (различные хидеры
 * для practice/conceal/gamebook); в FR1 используем только `'analysis'`
 * (свободный анализ / сохранённая запись без `gameId`).
 *
 * Условие рендера (`{!gameId && <AnalysisHeader ... />}`) остаётся в
 * AnalysisPage — для review-режима (с `gameId`) header не нужен:
 * там вместо него `GameMetaBar` показывает игроков/время.
 */

export type AnalysisHeaderMode = 'analysis';

export interface AnalysisHeaderContext {
  /** В FR1 используем только `'analysis'`. FM1-FM5 расширят union. */
  mode: AnalysisHeaderMode;
  /** Breadcrumb root (например, «Мастерская»). */
  breadcrumbRootTitle?: string;
  breadcrumbRootUrl?: string;
  /** Вложенный раздел (например, «Мои анализы»). */
  breadcrumbSection?: string;
  breadcrumbBackUrl?: string;
  breadcrumbBackState?: unknown;
  /** PGN-файл (для импорта). */
  breadcrumbFileName?: string;
  breadcrumbFileBackUrl?: string;
  breadcrumbFileBackState?: unknown;
}

export interface AnalysisHeaderProps {
  context: AnalysisHeaderContext;
  /** Текст заголовка (отображается в breadcrumb'е справа). */
  analysisTitle: string;
  /** Активный режим inline-редактирования заголовка. */
  isEditingTitle: boolean;
  titleInput: string;
  onTitleInputChange: (next: string) => void;
  onTitleSave: () => void;
  onTitleKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onTitleClick: () => void;
}

export function AnalysisHeader({
  context,
  analysisTitle,
  isEditingTitle,
  titleInput,
  onTitleInputChange,
  onTitleSave,
  onTitleKeyDown,
  onTitleClick,
}: AnalysisHeaderProps) {
  const { t } = useTranslation();

  return (
    <>
      <div
        className="analysis-workshop-shortcut"
        data-testid="analysis-header-shortcut"
      >
        <Link to="/workshop" className="analysis-workshop-shortcut__link">
          {t('workshop.title')}
        </Link>
        <HelpButton section="analyze" />
      </div>
      <nav
        className="analysis-breadcrumbs"
        data-testid="analysis-header-breadcrumbs"
      >
        <Link
          to={context.breadcrumbRootUrl ?? '/workshop'}
          className="analysis-breadcrumbs__link"
        >
          {context.breadcrumbRootTitle ?? t('workshop.title')}
        </Link>
        {context.breadcrumbSection && (
          <>
            <span className="analysis-breadcrumbs__sep"> / </span>
            <Link
              to={context.breadcrumbBackUrl ?? '/workshop'}
              state={context.breadcrumbBackState}
              className="analysis-breadcrumbs__link"
            >
              {context.breadcrumbSection}
            </Link>
          </>
        )}
        {context.breadcrumbFileName && (
          <>
            <span className="analysis-breadcrumbs__sep"> / </span>
            <Link
              to={context.breadcrumbFileBackUrl ?? '/workshop/pgn-files'}
              state={context.breadcrumbFileBackState}
              className="analysis-breadcrumbs__link"
            >
              {context.breadcrumbFileName}
            </Link>
          </>
        )}
        <span className="analysis-breadcrumbs__sep"> / </span>
        {isEditingTitle ? (
          <input
            className="analysis-title__input analysis-breadcrumbs__input"
            data-testid="analysis-header-title-input"
            value={titleInput}
            onChange={(e) => onTitleInputChange(e.target.value)}
            onBlur={onTitleSave}
            onKeyDown={onTitleKeyDown}
            autoFocus
            maxLength={100}
          />
        ) : (
          <span
            className="analysis-breadcrumbs__current"
            data-testid="analysis-header-title"
            onClick={onTitleClick}
            title={t('analysis.editTitle', 'Click to edit title')}
          >
            <span className="analysis-breadcrumbs__current-text">
              {analysisTitle}
            </span>
            <span className="analysis-title__edit-icon">✎</span>
          </span>
        )}
      </nav>
    </>
  );
}
