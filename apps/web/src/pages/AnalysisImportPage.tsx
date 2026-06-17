/**
 * KS-4320. Публичная страница `/analysis/import` — лендинг с UI вставки
 * PGN и длинным SEO-блоком ниже.
 *
 * UI намеренно минимальный:
 *  - textarea для PGN-текста;
 *  - кнопка «Открыть в анализаторе» → navigate('/analysis', { state: { pgn } });
 *  - ссылка на основной анализатор.
 *
 * Реальная функциональность импорта (drag&drop файла, multi-PGN, OCR
 * по скриншоту) живёт внутри AnalysisPage; этот маршрут — точка входа
 * для людей, пришедших из поиска по запросу «import PGN chess analyze».
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { PageSeo } from '../components/seo/PageSeo';
import { AnalysisImportSeoSection } from '../components/seo/sections/AnalysisImportSeoSection';

export function AnalysisImportPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pgn, setPgn] = useState('');

  const trimmed = pgn.trim();

  const handleOpen = () => {
    if (!trimmed) return;
    navigate('/analysis', { state: { pgn: trimmed } });
  };

  return (
    <div className="analysis-import-page">
      <PageSeo
        ns="analysisImport"
        path="/analysis/import"
        ogImage="/og/analysis-import.png"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'WebApplication',
          name: 'Kingside PGN Import',
          applicationCategory: 'GameApplication',
          operatingSystem: 'Web',
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        }}
      />
      <div
        style={{
          maxWidth: 720,
          margin: '32px auto 0',
          padding: '0 16px',
        }}
      >
        <h1 style={{ marginTop: 0 }}>
          {t(
            'analysisImport.heading',
            'Import a PGN and open it in the analyzer',
          )}
        </h1>
        <p>
          {t(
            'analysisImport.intro',
            'Paste the PGN of your game (from chess.com, lichess, ChessBase or any source). Kingside opens it with Stockfish 18 evaluation and AI commentary on every move.',
          )}
        </p>
        <textarea
          data-testid="analysis-import-pgn"
          value={pgn}
          onChange={(e) => setPgn(e.target.value)}
          placeholder={t(
            'analysisImport.placeholder',
            'Paste PGN here…',
          )}
          rows={12}
          style={{
            width: '100%',
            fontFamily: 'monospace',
            fontSize: 14,
            padding: 12,
            background: 'var(--bg-elevated, rgba(255,255,255,0.04))',
            color: 'var(--text-primary, #f5f5f5)',
            border: '1px solid var(--border-mid, #2a2f4a)',
            borderRadius: 6,
            boxSizing: 'border-box',
            resize: 'vertical',
          }}
        />
        <div style={{ marginTop: 12, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            data-testid="analysis-import-open"
            onClick={handleOpen}
            disabled={!trimmed}
            style={{
              padding: '8px 16px',
              fontSize: 16,
              fontWeight: 600,
              border: '1px solid var(--border-mid, #2a2f4a)',
              borderRadius: 6,
              background: trimmed
                ? 'var(--accent, #4f46e5)'
                : 'var(--bg-elevated, rgba(255,255,255,0.04))',
              color: trimmed ? '#fff' : 'var(--text-muted, #888)',
              cursor: trimmed ? 'pointer' : 'not-allowed',
            }}
          >
            {t('analysisImport.open', 'Open in analyzer')}
          </button>
          <a
            href="/analysis"
            style={{
              padding: '8px 16px',
              fontSize: 16,
              color: 'var(--link-color, #6ea8ff)',
              alignSelf: 'center',
            }}
          >
            {t('analysisImport.openEmpty', 'Or open an empty analyzer')}
          </a>
        </div>
      </div>

      <AnalysisImportSeoSection />
    </div>
  );
}
