import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function WorkshopPgnUpload() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const pgn = ev.target?.result as string;
      if (pgn) {
        navigate('/analysis', { state: { pgn } });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <section className="workshop-section-block">
      <h2 className="workshop-section-block__title">{t('workshop.pgnUpload.title')}</h2>
      <p className="workshop-section-block__desc">{t('workshop.pgnUpload.desc')}</p>

      <input
        ref={inputRef}
        type="file"
        accept=".pgn"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      <div className="workshop-pgn-upload">
        <button
          className="workshop-pgn-upload__btn"
          onClick={() => inputRef.current?.click()}
        >
          {t('workshop.pgnUpload.button')}
        </button>

        <button
          className="workshop-pgn-upload__btn workshop-pgn-upload__btn--secondary"
          onClick={() => navigate('/analysis')}
        >
          {t('workshop.pgnUpload.newAnalysis')}
        </button>
      </div>
    </section>
  );
}
