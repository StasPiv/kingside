// Telegram OAuth — single source of truth for redirect logic.
// Used by LoginPage and MainLayout.

const TELEGRAM_BOT_ID = import.meta.env.VITE_TELEGRAM_BOT_ID ?? '8447702776';

// Module-level constant prevents esbuild from optimizing away VITE_APP_ORIGIN (see KS-1179).
const CONFIGURED_ORIGIN: string | undefined = import.meta.env.VITE_APP_ORIGIN;

/**
 * Returns the app origin with www. stripped (Telegram BotFather domain is without www).
 */
export function getAppOrigin(): string {
  const raw = CONFIGURED_ORIGIN || window.location.origin;
  return raw.replace(/^(https?:\/\/)www\./i, '$1');
}

/**
 * Redirects to Telegram OAuth authorization page.
 */
export function redirectToTelegramOAuth(): void {
  const origin = getAppOrigin();
  const returnTo = `${origin}/login`;
  window.location.href =
    `https://oauth.telegram.org/auth` +
    `?bot_id=${TELEGRAM_BOT_ID}` +
    `&origin=${encodeURIComponent(origin)}` +
    `&return_to=${encodeURIComponent(returnTo)}`;
}
