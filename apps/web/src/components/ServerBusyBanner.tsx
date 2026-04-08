import { useTranslation } from 'react-i18next';

export function ServerBusyBanner() {
  const { t } = useTranslation();
  return (
    <div className="server-busy-banner">
      <span className="server-busy-banner__spinner" />
      <span>
        {t(
          'serverBusy.message',
          'Please wait, scaling up. Your game will start in ~1 minute.',
        )}
      </span>
    </div>
  );
}
