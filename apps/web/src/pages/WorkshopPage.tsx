import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkshopAnalysisList } from '../components/workshop/WorkshopAnalysisList';
import { WorkshopPgnUpload } from '../components/workshop/WorkshopPgnUpload';
import { WorkshopPgnList } from '../components/workshop/WorkshopPgnList';
import type { PgnFile } from '../components/workshop/WorkshopPgnList';

type Section = 'myAnalyses' | 'pgnFiles';

export function WorkshopPage() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>('myAnalyses');
  const [selectedPgnFile, setSelectedPgnFile] = useState<PgnFile | null>(null);

  const handleSectionChange = (newSection: Section) => {
    setSection(newSection);
    setSelectedPgnFile(null);
  };

  const handleSelectFile = (file: PgnFile) => {
    setSelectedPgnFile(file);
  };

  const handleBackToFiles = () => {
    setSelectedPgnFile(null);
  };

  const handleBackToWorkshop = () => {
    setSection('myAnalyses');
    setSelectedPgnFile(null);
  };

  return (
    <div className="workshop-page">
      <nav className="workshop-breadcrumbs">
        <button
          className="workshop-breadcrumbs__link"
          onClick={handleBackToWorkshop}
        >
          {t('workshop.title')}
        </button>
        <span className="workshop-breadcrumbs__sep"> / </span>
        {section === 'myAnalyses' ? (
          <span className="workshop-breadcrumbs__current">
            {t('workshop.myAnalyses.title')}
          </span>
        ) : selectedPgnFile ? (
          <>
            <button
              className="workshop-breadcrumbs__link"
              onClick={handleBackToFiles}
            >
              {t('workshop.pgnFiles.title')}
            </button>
            <span className="workshop-breadcrumbs__sep"> / </span>
            <span className="workshop-breadcrumbs__current">{selectedPgnFile.name}</span>
          </>
        ) : (
          <span className="workshop-breadcrumbs__current">
            {t('workshop.pgnFiles.title')}
          </span>
        )}
      </nav>

      <div className="workshop-section-tabs">
        <button
          className={`workshop-section-tab${section === 'myAnalyses' ? ' active' : ''}`}
          onClick={() => handleSectionChange('myAnalyses')}
        >
          {t('workshop.myAnalyses.title')}
        </button>
        <button
          className={`workshop-section-tab${section === 'pgnFiles' ? ' active' : ''}`}
          onClick={() => handleSectionChange('pgnFiles')}
        >
          {t('workshop.pgnFiles.title')}
        </button>
      </div>

      <div className="workshop-page__content">
        {section === 'myAnalyses' && (
          <>
            <WorkshopPgnUpload />
            <WorkshopAnalysisList />
          </>
        )}
        {section === 'pgnFiles' && (
          <WorkshopPgnList
            selectedFile={selectedPgnFile}
            onSelectFile={handleSelectFile}
          />
        )}
      </div>
    </div>
  );
}
