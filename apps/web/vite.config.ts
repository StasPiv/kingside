import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import { execSync } from 'child_process';
import fs from 'fs';

function getVersion(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const since = `${y}-${m}-${d}T00:00:00`;
  let n = 1;
  try {
    const out = execSync(`git log --oneline --since='${since}'`, { encoding: 'utf-8' });
    n = out.trim().split('\n').filter(Boolean).length || 1;
  } catch { /* fallback */ }
  return `${y}.${m}.${d}.${n}`;
}

function versionPlugin(): Plugin {
  return {
    name: 'version-json',
    buildStart() {
      const dest = path.resolve(__dirname, 'public/version.json');
      fs.writeFileSync(dest, JSON.stringify({ version: getVersion() }));
    },
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version: getVersion() }));
      });
    },
  };
}

// Load per-app env files (apps/web/.env.local, .env.development.local, .env)
// in addition to the shared monorepo envDir below. Per-app overrides are useful
// when the root .env is managed by devops и ещё не содержит новую переменную —
// разработчик/агент добавляет VITE_* в apps/web/.env.local без правки корня.
// KS-1699: VITE_BROADCAST_URL добавляется именно так до того, как devops
// пропишет её в /project/.env хоста.
const APP_ENV_MODE = process.env.NODE_ENV ?? 'development';
const perAppEnv = loadEnv(APP_ENV_MODE, __dirname, '');
for (const key of Object.keys(perAppEnv)) {
  if (key.startsWith('VITE_') && process.env[key] === undefined) {
    process.env[key] = perAppEnv[key];
  }
}

export default defineConfig({
  plugins: [
    versionPlugin(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // KS-3237: includeAssets копирует файлы в dist/. Иконки лежат в
      // public/icons/, vite сам кладёт их в корень dist/icons/ — для
      // manifest достаточно указать относительные пути ниже.
      // icon.svg остаётся как fallback для favicon.
      includeAssets: ['icon.svg', 'favicon.ico', 'icons/*.png'],
      devOptions: {
        enabled: false,
      },
      manifest: {
        name: 'Kingside — Online Chess',
        short_name: 'Kingside',
        description: 'Play chess online with friends',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        // KS-3237: PNG-иконки для Add-to-Home-Screen (Android Chrome
        // 192/512, iOS Safari 180 — последнее задаётся отдельно через
        // apple-touch-icon в index.html, в manifest icons помещён 192
        // и 512 для Android + maskable-512 для адаптивных лаунчеров
        // (Pixel Launcher, OneUI и пр., см. web.dev/maskable-icon).
        // SVG оставляем `any` — современные браузеры всё ещё используют
        // его в табе и истории, а Android, согласно спеке, выбирает
        // ближайший по `sizes` среди PNG.
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        // KS-2917: index.html ДОЛЖЕН быть в precache. По умолчанию vite-pwa
        // выставляет workbox.navigateFallback = "index.html", и worbox-build
        // в шаблоне sw.js рендерит
        //   registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")))
        // createHandlerBoundToURL синхронно бросает WorkboxError
        // `non-precached-url`, если URL не в precache (workbox-precaching
        // PrecacheController.ts:355). Скрипт SW падает, новый Service Worker
        // не активируется, клиент остаётся со старым manifest'ом и тянет
        // уже удалённые из бакета чанки → CDN/S3 отдаёт 403.
        // Поэтому index.html добавлен в globPatterns — workbox его
        // precache'ит с revision'ом, NavigationRoute обслуживается из
        // precache. На следующем деплое cleanupOutdatedCaches удалит
        // старую копию, новый SW активируется, navigations берут свежий
        // index.html, dynamic-import тянет актуальные hash-чанки.
        // JS/CSS не precache'ятся (NetworkFirst в runtimeCaching ниже).
        globPatterns: ['**/*.{svg,png,woff2,html}'],
        globIgnores: ['**/stockfish/**'],
        // KS-2917: явный navigateFallback (не полагаемся на default
        // vite-pwa). Если в будущем обновится vite-plugin-pwa с другим
        // дефолтом — поведение конфига останется предсказуемым.
        navigateFallback: 'index.html',
        // KS-2917: SPA-навигация перехватывает только пути приложения.
        // Запросы к /api/, /assets/ (hash-чанки) и /sw.js должны идти
        // в нормальный фетч без подмены на index.html.
        navigateFallbackDenylist: [/^\/api\//, /^\/assets\//, /\/sw\.js$/],
        runtimeCaching: [
          {
            // JS and CSS: network first, fall back to cache
            urlPattern: /\.(?:js|css)$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'assets-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 86400,
              },
            },
          },
          // KS-2917: runtimeCaching-запись для navigate-режима удалена.
          // Она была недостижима — auto-added NavigationRoute из
          // navigateFallback регистрируется первым и съедает все
          // navigation-запросы. Теперь весь navigate-фетч проходит через
          // precached index.html (всегда актуальный для активного SW).
          //
          // KS-2402: блок NetworkFirst для `/api/(?!auth/)` удалён.
          // Причина — баг «одна и та же позиция»: на медленной сети
          // workbox отдавал из api-cache ответ от другого URL (например,
          // /analyses/UUID-A в ответ на /analyses/UUID-B), потому что
          // NetworkFirst при таймауте fallback'ит на cache. Кеш API на
          // SW-уровне не нужен — ETag/Cache-Control из бэкенда (KS-2376
          // и общие настройки) работают на уровне браузера, а SW-слой
          // ломал per-resource invalidation.
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // KS-2079 / L1: dev-proxy для archive-сервиса. Прод archive-сервис
    // отдаёт CORS только для своих доменов (archive.kingside.site,
    // kingside.site), запросы с http://localhost:5173 он режет.
    // Решение: в dev фронт ходит на относительный `/__archive/...`,
    // vite сам проксирует на `https://archive.kingside.site` с
    // `changeOrigin: true` — браузер видит same-origin, CORS не
    // применяется. В prod-сборке `VITE_ARCHIVE_URL` инжектируется
    // нормальным абсолютным URL'ом (`https://archive.kingside.site`)
    // через scripts/deploy-aws.sh, так что proxy задействован только
    // в dev.
    proxy: {
      '/__archive': {
        target: 'https://archive.kingside.site',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/__archive/, ''),
      },
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    force: false,
  },
  envDir: path.resolve(__dirname, '../..'),
  resolve: {
    alias: {
      '@kingside/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
});
