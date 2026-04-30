import { useTranslation } from 'react-i18next';

/**
 * KS-2169 (F4): Terms of Service — публичная страница условий использования.
 * Содержит soft-disclosure параграф про synthetic-соперников
 * (`tos.matchmakingSyntheticDisclosure`), как требует ADR-034 Q1=B.
 */
export function TermsOfServicePage() {
  const { t } = useTranslation();
  return (
    <div className="terms-page" style={{ maxWidth: 760, margin: '24px auto', padding: '0 16px', lineHeight: 1.6 }}>
      <h1>{t('tos.title', 'Terms of Service')}</h1>
      <p style={{ opacity: 0.75, fontSize: 13 }}>
        {t('tos.lastUpdated', 'Last updated: {{date}}', { date: '2026-04-30' })}
      </p>

      <section>
        <h2>{t('tos.intro.title', '1. Introduction')}</h2>
        <p>{t('tos.intro.body', 'These Terms of Service govern your use of Kingside. By creating an account or using the platform, you agree to be bound by these terms.')}</p>
      </section>

      <section>
        <h2>{t('tos.account.title', '2. Account')}</h2>
        <p>{t('tos.account.body', 'You are responsible for maintaining the confidentiality of your credentials and for all activity under your account. You must be at least 13 years old to create an account.')}</p>
      </section>

      <section>
        <h2>{t('tos.gameplay.title', '3. Gameplay and matchmaking')}</h2>
        <p>{t('tos.gameplay.body', 'You may play rated and unrated games against other users. Ratings are calculated based on the Glicko-2 system.')}</p>
        {/* KS-2169 (F4): обязательная soft-disclosure фраза про synthetic-соперников. */}
        <p data-testid="tos-synthetic-disclosure">
          {t(
            'tos.matchmakingSyntheticDisclosure',
            'In low-traffic time slots, the system may pair you with system-generated opponents to ensure timely matchmaking.',
          )}
        </p>
      </section>

      <section>
        <h2>{t('tos.fairPlay.title', '4. Fair play')}</h2>
        <p>{t('tos.fairPlay.body', 'You must not use chess engines, external assistance, or coordinate with other players to manipulate ratings or outcomes. Violations may result in account suspension and rating reset.')}</p>
      </section>

      <section>
        <h2>{t('tos.content.title', '5. User content')}</h2>
        <p>{t('tos.content.body', 'You retain ownership of content you submit (analyses, comments, messages). By submitting, you grant Kingside a non-exclusive license to display it within the platform.')}</p>
      </section>

      <section>
        <h2>{t('tos.privacy.title', '6. Privacy')}</h2>
        <p>{t('tos.privacy.body', 'We process personal data in accordance with our Privacy Policy. Game records and ratings are public; private messages are visible only to participants.')}</p>
      </section>

      <section>
        <h2>{t('tos.changes.title', '7. Changes')}</h2>
        <p>{t('tos.changes.body', 'We may update these terms from time to time. Material changes will be announced via email or in-app notification.')}</p>
      </section>

      <section>
        <h2>{t('tos.contact.title', '8. Contact')}</h2>
        <p>{t('tos.contact.body', 'For questions about these terms, contact us via the support form on the website.')}</p>
      </section>
    </div>
  );
}
