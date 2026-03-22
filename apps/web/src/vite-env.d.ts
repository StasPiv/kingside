/// <reference types="vite/client" />


interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_TELEGRAM_BOT_USERNAME: string;
  readonly VITE_TELEGRAM_BOT_ID: string;
  readonly VITE_DEV_BYPASS_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
