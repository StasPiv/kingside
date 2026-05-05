import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TacticDrillType } from '@kingside/shared';

import { DrillBoard } from '../components/drills';

/**
 * KS-2418 — публичная страница «Как работают тренажёры» (`/drills/about`).
 *
 * Контент берётся из `docs/user/drills-public.md` (architect, KS-2417),
 * раскладывается в i18n-ключах:
 *   - `drills.about.intro` — введение.
 *   - `drills.about.modesNote` — упоминание спринта и daily.
 *   - `drills.types.<type>` — название (одинаково для лобби и about).
 *   - `drills.oneLiners.<type>` — короткая фраза.
 *   - `drills.whatItTrains.<type>` — длинное описание.
 *   - `drills.howToAnswer.<type>` — формат ответа.
 *   - `drills.examples.<type>.fen` + `.text` — пример позиции.
 *   - `drills.about.tips` — советы при прохождении (массив).
 *
 * Каждая карточка содержит read-only `<DrillBoard>` с FEN из примера.
 * Гейт страницы — тот же `drillsEnabled`, что и для лобби (см. App.tsx).
 */

const DRILL_TYPES: { id: TacticDrillType; key: string }[] = [
  { id: 'find-hanging-piece', key: 'findHangingPiece' },
  { id: 'find-loose-piece', key: 'findLoosePiece' },
  { id: 'find-pin', key: 'findPin' },
  { id: 'find-fork', key: 'findFork' },
  { id: 'count-attackers', key: 'countAttackers' },
  { id: 'find-all-checks', key: 'findAllChecks' },
  { id: 'find-undefended-attack', key: 'findUndefendedAttack' },
];

export function DrillsAboutPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // Чтение массива советов через i18n. `returnObjects: true` отдаёт
  // массив строк; на случай отсутствия ключа кастуем к unknown и
  // фильтруем — не падаем при странной локали.
  const tipsRaw = t('drills.about.tips', { returnObjects: true });
  const tips: string[] = Array.isArray(tipsRaw)
    ? (tipsRaw as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  return (
    <div className="drills-about" data-testid="drills-about">
      <header className="drills-about__header">
        <button
          type="button"
          className="drills-about__back"
          data-testid="drills-about-back"
          onClick={() => navigate('/drills')}
        >
          ← {t('drills.about.backToLobby', 'Back to drills')}
        </button>
        <h1 className="drills-about__title">
          {t('drills.about.title', 'How drills work')}
        </h1>
        <p className="drills-about__subtitle">
          {t(
            'drills.about.subtitle',
            'What a drill is, how to solve each type and what the board expects from you.',
          )}
        </p>
      </header>

      <section
        className="drills-about__intro"
        data-testid="drills-about-intro"
      >
        <h2 className="drills-about__section-title">
          {t('drills.about.introTitle', 'What a drill is')}
        </h2>
        <p className="drills-about__paragraph">
          {t('drills.about.intro')}
        </p>
        <p className="drills-about__paragraph drills-about__paragraph--note">
          {t('drills.about.modesNote')}
        </p>
      </section>

      <section
        className="drills-about__cards"
        data-testid="drills-about-cards"
      >
        {DRILL_TYPES.map(({ id, key }) => {
          const fen = t(`drills.examples.${key}.fen`);
          const exampleText = t(`drills.examples.${key}.text`);
          return (
            <article
              key={id}
              className="drills-about__card"
              data-testid={`drills-about-card-${id}`}
              data-drill-type={id}
            >
              <header className="drills-about__card-header">
                <h3 className="drills-about__card-title">
                  {t(`drills.types.${key}`)}
                </h3>
                <p className="drills-about__card-oneliner">
                  {t(`drills.oneLiners.${key}`)}
                </p>
              </header>

              <div className="drills-about__card-body">
                <section className="drills-about__card-section">
                  <h4 className="drills-about__card-subtitle">
                    {t('drills.about.whatItTrainsLabel', 'What it trains')}
                  </h4>
                  <p className="drills-about__paragraph">
                    {t(`drills.whatItTrains.${key}`)}
                  </p>
                </section>

                <section className="drills-about__card-section">
                  <h4 className="drills-about__card-subtitle">
                    {t('drills.about.howToAnswerLabel', 'How to answer')}
                  </h4>
                  <p className="drills-about__paragraph">
                    {t(`drills.howToAnswer.${key}`)}
                  </p>
                </section>

                <section className="drills-about__card-section drills-about__card-section--example">
                  <h4 className="drills-about__card-subtitle">
                    {t('drills.about.exampleLabel', 'Example')}
                  </h4>
                  <div className="drills-about__example">
                    <div className="drills-about__example-board">
                      <DrillBoard position={fen} />
                    </div>
                    <p className="drills-about__paragraph drills-about__paragraph--example">
                      {exampleText}
                    </p>
                  </div>
                </section>

                <button
                  type="button"
                  className="drills-about__card-cta"
                  data-testid={`drills-about-open-${id}`}
                  onClick={() => navigate(`/drills/${id}`)}
                >
                  {t('drills.about.openDrill', 'Open drill')} →
                </button>
              </div>
            </article>
          );
        })}
      </section>

      <section
        className="drills-about__tips"
        data-testid="drills-about-tips"
      >
        <h2 className="drills-about__section-title">
          {t('drills.about.tipsTitle', 'Tips while solving')}
        </h2>
        <ul className="drills-about__tips-list">
          {tips.map((tip, idx) => (
            <li key={idx} className="drills-about__tip-item">
              {tip}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
