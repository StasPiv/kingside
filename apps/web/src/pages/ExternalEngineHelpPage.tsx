import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function ExternalEngineHelpPage() {
  const { t } = useTranslation();

  return (
    <div className="help-page">
      <Link to="/analysis" className="player-profile-back">
        {t('engineHelp.backToAnalysis')}
      </Link>

      <h1>{t('engineHelp.title')}</h1>
      <p className="help-intro">{t('engineHelp.intro')}</p>

      <div className="help-steps">
        <div className="help-step">
          <div className="help-step-number">1</div>
          <div className="help-step-content">
            <h3>{t('engineHelp.step1Title')}</h3>
            <p>{t('engineHelp.step1Desc')}</p>
            <a
              href="https://github.com/StasPiv/kingside/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="help-link"
            >
              {t('engineHelp.step1Link')}
            </a>
          </div>
        </div>

        <div className="help-step">
          <div className="help-step-number">2</div>
          <div className="help-step-content">
            <h3>{t('engineHelp.step2Title')}</h3>
            <p>{t('engineHelp.step2Desc')}</p>
            <a
              href="https://stockfishchess.org/download/"
              target="_blank"
              rel="noopener noreferrer"
              className="help-link"
            >
              {t('engineHelp.step2Link')}
            </a>
          </div>
        </div>

        <div className="help-step">
          <div className="help-step-number">3</div>
          <div className="help-step-content">
            <h3>{t('engineHelp.step3Title')}</h3>
            <p>{t('engineHelp.step3Desc')}</p>
            <code className="help-code">./kingside-engine-bridge</code>
          </div>
        </div>

        <div className="help-step">
          <div className="help-step-number">4</div>
          <div className="help-step-content">
            <h3>{t('engineHelp.step4Title')}</h3>
            <p>{t('engineHelp.step4Desc')}</p>
            <code className="help-code">config.yaml → secret_key: "your-key"</code>
          </div>
        </div>

        <div className="help-step">
          <div className="help-step-number">5</div>
          <div className="help-step-content">
            <h3>{t('engineHelp.step5Title')}</h3>
            <p>{t('engineHelp.step5Desc')}</p>
          </div>
        </div>

        <div className="help-step">
          <div className="help-step-number">6</div>
          <div className="help-step-content">
            <h3>{t('engineHelp.step6Title')}</h3>
            <p>{t('engineHelp.step6Desc')}</p>
            <code className="help-code">ws://localhost:9090</code>
          </div>
        </div>

        <div className="help-step">
          <div className="help-step-number">7</div>
          <div className="help-step-content">
            <h3>{t('engineHelp.step7Title')}</h3>
            <p>{t('engineHelp.step7Desc')}</p>
          </div>
        </div>
      </div>

      <div className="help-faq">
        <h2>{t('engineHelp.faqTitle')}</h2>

        <h3>{t('engineHelp.faqConfigTitle')}</h3>
        <p>{t('engineHelp.faqConfigDesc')}</p>

        <h4>{t('engineHelp.faqConfigWindows')}</h4>
        <pre className="help-code-block">
{`engine_path: ".\\stockfish-windows-x86-64-avx2.exe"
port: 9090
secret_key: "5caa600aebd56a95a625637d6a55bc5e"`}
        </pre>
        <p className="help-note">{t('engineHelp.faqWindowsPathNote')}</p>

        <h4>{t('engineHelp.faqConfigLinux')}</h4>
        <pre className="help-code-block">
{`engine_path: "/usr/games/stockfish"
port: 9090
secret_key: "5caa600aebd56a95a625637d6a55bc5e"`}
        </pre>

        <h4>{t('engineHelp.faqConfigMac')}</h4>
        <pre className="help-code-block">
{`engine_path: "/opt/homebrew/bin/stockfish"
port: 9090
secret_key: "5caa600aebd56a95a625637d6a55bc5e"`}
        </pre>

        <p className="help-note">{t('engineHelp.faqSecretKeyNote')}</p>
      </div>
    </div>
  );
}
