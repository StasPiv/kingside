import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { AnalysisHeader } from './AnalysisHeader';

/**
 * KS-2863 (ADR-060 §10.1 FR1): unit-тесты извлечённого AnalysisHeader.
 *
 * Компонент презентационный — проверяем рендер по props (breadcrumbs,
 * inline-edit title state).
 */

const DEFAULT_PROPS = {
  context: {
    mode: 'analysis' as const,
    breadcrumbRootTitle: 'Workshop',
    breadcrumbRootUrl: '/workshop',
  },
  analysisTitle: 'My analysis',
  isEditingTitle: false,
  titleInput: 'My analysis',
  onTitleInputChange: () => {},
  onTitleSave: () => {},
  onTitleKeyDown: () => {},
  onTitleClick: () => {},
};

describe('<AnalysisHeader> (KS-2863)', () => {
  it('рендерит workshop-shortcut + breadcrumb root + title', () => {
    renderWithProviders(<AnalysisHeader {...DEFAULT_PROPS} />);
    expect(screen.getByTestId('analysis-header-shortcut')).toBeInTheDocument();
    expect(
      screen.getByTestId('analysis-header-breadcrumbs'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('analysis-header-title')).toHaveTextContent(
      'My analysis',
    );
  });

  it('рендерит breadcrumb section + file когда заданы', () => {
    renderWithProviders(
      <AnalysisHeader
        {...DEFAULT_PROPS}
        context={{
          ...DEFAULT_PROPS.context,
          breadcrumbSection: 'My analyses',
          breadcrumbBackUrl: '/workshop/mine',
          breadcrumbFileName: 'game.pgn',
          breadcrumbFileBackUrl: '/workshop/pgn-files',
        }}
      />,
    );
    expect(screen.getByText('My analyses')).toBeInTheDocument();
    expect(screen.getByText('game.pgn')).toBeInTheDocument();
  });

  it('isEditingTitle=true → input с autofocus вместо span', () => {
    renderWithProviders(
      <AnalysisHeader
        {...DEFAULT_PROPS}
        isEditingTitle
        titleInput="Editing…"
      />,
    );
    const input = screen.getByTestId('analysis-header-title-input');
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe('Editing…');
    expect(screen.queryByTestId('analysis-header-title')).not.toBeInTheDocument();
  });

  it('click на title → onTitleClick', () => {
    const onTitleClick = vi.fn();
    renderWithProviders(
      <AnalysisHeader {...DEFAULT_PROPS} onTitleClick={onTitleClick} />,
    );
    fireEvent.click(screen.getByTestId('analysis-header-title'));
    expect(onTitleClick).toHaveBeenCalled();
  });

  it('input onChange → onTitleInputChange с новым значением', () => {
    const onTitleInputChange = vi.fn();
    renderWithProviders(
      <AnalysisHeader
        {...DEFAULT_PROPS}
        isEditingTitle
        onTitleInputChange={onTitleInputChange}
      />,
    );
    fireEvent.change(screen.getByTestId('analysis-header-title-input'), {
      target: { value: 'New' },
    });
    expect(onTitleInputChange).toHaveBeenCalledWith('New');
  });

  it('input onBlur → onTitleSave', () => {
    const onTitleSave = vi.fn();
    renderWithProviders(
      <AnalysisHeader
        {...DEFAULT_PROPS}
        isEditingTitle
        onTitleSave={onTitleSave}
      />,
    );
    fireEvent.blur(screen.getByTestId('analysis-header-title-input'));
    expect(onTitleSave).toHaveBeenCalled();
  });

  it('input keydown → onTitleKeyDown', () => {
    const onTitleKeyDown = vi.fn();
    renderWithProviders(
      <AnalysisHeader
        {...DEFAULT_PROPS}
        isEditingTitle
        onTitleKeyDown={onTitleKeyDown}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('analysis-header-title-input'), {
      key: 'Enter',
    });
    expect(onTitleKeyDown).toHaveBeenCalled();
  });

  it('дефолтный root-URL = /workshop когда breadcrumbRootUrl не задан', () => {
    renderWithProviders(
      <AnalysisHeader
        {...DEFAULT_PROPS}
        context={{ mode: 'analysis' }}
      />,
    );
    // Hardcoded `t('workshop.title')` через i18n test-instance → 'Workshop' в en.
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].getAttribute('href')).toBe('/workshop');
  });
});
