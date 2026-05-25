/**
 * KS-3320. Страница `/credits` — атрибуция авторов и лицензий открытых
 * ассетов, используемых на Kingside.
 *
 * Сейчас покрывает только piece-set'ы. Архитектурно расширяется на
 * sound-themes, board-themes, иконки и т.д. при необходимости.
 *
 * Источник лицензионных данных:
 *   https://github.com/lichess-org/lila/blob/master/COPYING.md
 * Файлы piece-set'ов взяты из `lichess-org/lila/public/piece/<set>/`.
 *
 * Выборка наборов следует strict-policy: только permissive лицензии
 * (Apache 2.0 / MIT / CC0 / CC BY / CC BY-SA). CC BY-NC-SA и
 * GPL/AGPL не подключаются (политика проекта на коммерческое
 * использование без вирусной copyleft).
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PIECE_SETS } from '../context/BoardSettingsContext';

export function CreditsPage() {
  const { t } = useTranslation();
  const sets = PIECE_SETS.filter((s) => s.license !== null);
  return (
    <div
      className="credits-page"
      data-testid="credits-page"
      style={{
        maxWidth: 880,
        margin: '0 auto',
        padding: '28px 20px 48px',
        color: 'var(--text-primary)',
        lineHeight: 1.55,
      }}
    >
      <h1 style={{ margin: '0 0 12px', fontSize: 28, fontWeight: 700 }}>
        {t('credits.title', 'Credits & attributions')}
      </h1>
      <p style={{ margin: '0 0 24px', color: 'var(--text-secondary)' }}>
        {t(
          'credits.intro',
          'Kingside is grateful to the authors of the open-license assets used in this product. Each set below is bundled under its original license; click the license name for the full text.',
        )}
      </p>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 600 }}>
          {t('credits.pieceSets.title', 'Piece sets')}
        </h2>
        <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)' }}>
          {t(
            'credits.pieceSets.source',
            'Source: ',
          )}
          <a
            href="https://github.com/lichess-org/lila/tree/master/public/piece"
            target="_blank"
            rel="noopener noreferrer"
          >
            lichess-org/lila/public/piece
          </a>
          .{' '}
          {t(
            'credits.pieceSets.sourceCopying',
            'Authors and licenses come from the upstream ',
          )}
          <a
            href="https://github.com/lichess-org/lila/blob/master/COPYING.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            COPYING.md
          </a>
          .
        </p>
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {sets.map((s) => {
            const license = s.license!;
            return (
              <li
                key={s.id}
                data-testid={`credits-piece-set-${s.id}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 1fr',
                  gap: 12,
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--border-subtle)',
                  fontSize: 14,
                }}
              >
                <span style={{ fontWeight: 600 }}>{s.label}</span>
                <span>
                  {license.authorUrl ? (
                    <a
                      href={license.authorUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {license.author}
                    </a>
                  ) : (
                    license.author
                  )}
                </span>
                <span>
                  <a
                    href={license.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {license.name}
                  </a>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
          {t('credits.notes.title', 'License notes')}
        </h2>
        <ul style={{ paddingLeft: 18, margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>
          <li>
            {t(
              'credits.notes.shareAlike',
              'CC BY-SA 4.0 (shapes): downstream modifications must also be CC BY-SA 4.0.',
            )}
          </li>
          <li>
            {t(
              'credits.notes.attribution',
              'CC BY 4.0 (kiwen-suwi, firi, totoy): attribution is required when redistributing.',
            )}
          </li>
          <li>
            {t(
              'credits.notes.publicDomain',
              'CC0 1.0 (rhosgfx): public-domain dedication, attribution optional.',
            )}
          </li>
          <li>
            {t(
              'credits.notes.permissive',
              'MIT / Apache 2.0 (fantasy, spatial, celtic, chessnut): attribution preserved, no copyleft.',
            )}
          </li>
        </ul>
      </section>

      <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
        <Link to="/">← {t('credits.back', 'Back to Kingside')}</Link>
      </p>
    </div>
  );
}
