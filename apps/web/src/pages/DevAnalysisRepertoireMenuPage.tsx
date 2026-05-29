import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { AddToRepertoireModal } from './openingTrainer/AddToRepertoireModal';
import type { OpeningRepertoireDto } from '@kingside/shared';

/**
 * KS-3331 (ADR-078 §5.3) — dev-демо overflow-меню мастерской с ДВУМЯ
 * пунктами репертуара («Использовать как новый» + «Добавить в
 * существующий…») и модалкой выбора репертуара.
 * `/dev/analysis-repertoire-menu?dev_bypass=secret[&view=modal]`.
 *
 * Реальная структура `.analysis-overflow-menu` из AnalysisPage — для
 * acceptance-скриншота без поднятия полного состояния (сохранённый свой
 * анализ + список репертуаров).
 */

const MOCK_REPERTOIRES: OpeningRepertoireDto[] = [
  {
    id: 'r-1',
    ownerId: 'u-1',
    title: 'Italian Game',
    description: null,
    side: 'white',
    nodeCount: 24,
    edgeCount: 23,
    maxDepth: 8,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  },
  {
    id: 'r-2',
    ownerId: 'u-1',
    title: 'Caro-Kann Defense',
    description: null,
    side: 'black',
    nodeCount: 31,
    edgeCount: 30,
    maxDepth: 10,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-11T00:00:00.000Z',
  },
];

export function DevAnalysisRepertoireMenuPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [modalOpen, setModalOpen] = useState(params.get('view') === 'modal');

  return (
    <div style={{ maxWidth: 520, margin: '24px auto', padding: 16 }}>
      <h1>KS-3331 — overflow-меню: два пункта репертуара</h1>
      <p style={{ color: '#888', marginBottom: 20 }}>
        Реальная структура `.analysis-overflow-menu` мастерской. Два пункта:
        «{t('analysis.useAsRepertoire.menuItem', 'Use as new repertoire')}» и
        «{t('analysis.useAsRepertoire.addToExistingMenuItem', 'Add to existing repertoire…')}».
      </p>

      <div
        className="analysis-overflow-wrapper"
        style={{ position: 'relative', display: 'inline-block' }}
      >
        <div className="analysis-overflow-menu" style={{ position: 'static' }}>
          <button data-testid="dev-menu-find-games">
            {t('analysis.findGames', 'Find games with this position')}
          </button>
          <button data-testid="dev-menu-export">
            {t('analysis.exportPgn', 'Export PGN')}
          </button>
          <button data-testid="analysis-use-as-repertoire">
            {t('analysis.useAsRepertoire.menuItem', 'Use as new repertoire')}
          </button>
          <button
            data-testid="analysis-add-to-repertoire"
            onClick={() => setModalOpen(true)}
          >
            {t(
              'analysis.useAsRepertoire.addToExistingMenuItem',
              'Add to existing repertoire…',
            )}
          </button>
          <button data-testid="dev-menu-share">
            {t('analysis.share.menuItem', 'Share')}
          </button>
        </div>
      </div>

      {modalOpen && (
        <AddToRepertoireModal
          repertoires={MOCK_REPERTOIRES}
          submitting={false}
          onSelect={() => {}}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
