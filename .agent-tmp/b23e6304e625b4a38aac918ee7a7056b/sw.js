import {registerRoute as workbox_routing_registerRoute} from '/project/node_modules/workbox-routing/registerRoute.mjs';
import {ExpirationPlugin as workbox_expiration_ExpirationPlugin} from '/project/node_modules/workbox-expiration/ExpirationPlugin.mjs';
import {NetworkFirst as workbox_strategies_NetworkFirst} from '/project/node_modules/workbox-strategies/NetworkFirst.mjs';
import {clientsClaim as workbox_core_clientsClaim} from '/project/node_modules/workbox-core/clientsClaim.mjs';
import {precacheAndRoute as workbox_precaching_precacheAndRoute} from '/project/node_modules/workbox-precaching/precacheAndRoute.mjs';
import {cleanupOutdatedCaches as workbox_precaching_cleanupOutdatedCaches} from '/project/node_modules/workbox-precaching/cleanupOutdatedCaches.mjs';
import {NavigationRoute as workbox_routing_NavigationRoute} from '/project/node_modules/workbox-routing/NavigationRoute.mjs';
import {createHandlerBoundToURL as workbox_precaching_createHandlerBoundToURL} from '/project/node_modules/workbox-precaching/createHandlerBoundToURL.mjs';/**
 * Welcome to your Workbox-powered service worker!
 *
 * You'll need to register this file in your web app.
 * See https://goo.gl/nhQhGp
 *
 * The rest of the code is auto-generated. Please don't update this file
 * directly; instead, make changes to your Workbox build configuration
 * and re-run your build process.
 * See https://goo.gl/2aRDsh
 */








self.skipWaiting();

workbox_core_clientsClaim();


/**
 * The precacheAndRoute() method efficiently caches and responds to
 * requests for URLs in the manifest.
 * See https://goo.gl/S9QRab
 */
workbox_precaching_precacheAndRoute([
  {
    "url": "og-image.png",
    "revision": "38a9a784d35c717e70dc6dcb598f7dd3"
  },
  {
    "url": "icon.svg",
    "revision": "2a15d5d01cfc1210e555d54c8bfb4542"
  },
  {
    "url": "pieces/merida/wR.svg",
    "revision": "8a4f380ed506abbf1ef484d8d52a7fd8"
  },
  {
    "url": "pieces/merida/wQ.svg",
    "revision": "d8fe443f9bc1137189c191ac0ca440f3"
  },
  {
    "url": "pieces/merida/wP.svg",
    "revision": "fedfb5ddcdcd1b168ace5b1f7acb8452"
  },
  {
    "url": "pieces/merida/wN.svg",
    "revision": "2d1674c590a3a4ee6098d5a4c1a8810e"
  },
  {
    "url": "pieces/merida/wK.svg",
    "revision": "4faed434c9f4dd379c3c7d9cb780ca3f"
  },
  {
    "url": "pieces/merida/wB.svg",
    "revision": "321f1965cd4333a179c75d91f116de4b"
  },
  {
    "url": "pieces/merida/bR.svg",
    "revision": "10c08a451fff3b79b4b074f13070b8c2"
  },
  {
    "url": "pieces/merida/bQ.svg",
    "revision": "33ce2491d2c0f998e56879ce30bad9da"
  },
  {
    "url": "pieces/merida/bP.svg",
    "revision": "10443a045efec9ddeb27b703118d83d8"
  },
  {
    "url": "pieces/merida/bN.svg",
    "revision": "97a50010b9772138b53cc028fcb402fc"
  },
  {
    "url": "pieces/merida/bK.svg",
    "revision": "da013b32c215bbf97ca0adbdda4428f0"
  },
  {
    "url": "pieces/merida/bB.svg",
    "revision": "b178a7491fbc30b1d89d7ae86fe6f4df"
  },
  {
    "url": "pieces/cburnett/wR.svg",
    "revision": "2b171763b047d97b75cc81ffd13fa65a"
  },
  {
    "url": "pieces/cburnett/wQ.svg",
    "revision": "f23e5faa1515c650aecfa6587540259b"
  },
  {
    "url": "pieces/cburnett/wP.svg",
    "revision": "6f891a84f6611d3c35e4878961862d61"
  },
  {
    "url": "pieces/cburnett/wN.svg",
    "revision": "19fc70466873a0f2eb28589c1c8605d0"
  },
  {
    "url": "pieces/cburnett/wK.svg",
    "revision": "7d18a95384288aba1aa25a25ab414f59"
  },
  {
    "url": "pieces/cburnett/wB.svg",
    "revision": "b0e727696a8dea27425e41989d188c09"
  },
  {
    "url": "pieces/cburnett/bR.svg",
    "revision": "8fbed2cbcb7d96d34567d346f0ba8812"
  },
  {
    "url": "pieces/cburnett/bQ.svg",
    "revision": "14364b52ba9764da2f0613fe2074db19"
  },
  {
    "url": "pieces/cburnett/bP.svg",
    "revision": "48e87076aa493c1aa5bbdb9ab1c7b850"
  },
  {
    "url": "pieces/cburnett/bN.svg",
    "revision": "48ab07feadf5a502db6ca899059f87a2"
  },
  {
    "url": "pieces/cburnett/bK.svg",
    "revision": "f64ae111f63f5a1bf82976fd11d671e9"
  },
  {
    "url": "pieces/cburnett/bB.svg",
    "revision": "aa5bdbcda55c58802a4a343142f3d1b4"
  },
  {
    "url": "pieces/alpha/wR.svg",
    "revision": "02fc521bfb99827a821579f1c708e6b9"
  },
  {
    "url": "pieces/alpha/wQ.svg",
    "revision": "f2d77dd4d14ac552378bf45861d11b90"
  },
  {
    "url": "pieces/alpha/wP.svg",
    "revision": "c8a9e2bd78fd3e7272e55f286d274cc3"
  },
  {
    "url": "pieces/alpha/wN.svg",
    "revision": "cb5959521f59ead92094a6170193ed54"
  },
  {
    "url": "pieces/alpha/wK.svg",
    "revision": "2d0051820ffff99ffebe905fdf71b8d1"
  },
  {
    "url": "pieces/alpha/wB.svg",
    "revision": "c912c0d95e5b26be56aee354ae221c9c"
  },
  {
    "url": "pieces/alpha/bR.svg",
    "revision": "000b7e34665c571f14987a2066448d54"
  },
  {
    "url": "pieces/alpha/bQ.svg",
    "revision": "2dd5e5f04870db32fc62f4e5cea19b13"
  },
  {
    "url": "pieces/alpha/bP.svg",
    "revision": "44f64c44729da66ee6c112a32f5437f3"
  },
  {
    "url": "pieces/alpha/bN.svg",
    "revision": "3ff6dc620dbd27ca9477002f9a27bed4"
  },
  {
    "url": "pieces/alpha/bK.svg",
    "revision": "b26ed9748039d94dca27ccd6f996057a"
  },
  {
    "url": "pieces/alpha/bB.svg",
    "revision": "2ccc485c1cabbb57d728d3b9ba724e43"
  },
  {
    "url": "icon.svg",
    "revision": "2a15d5d01cfc1210e555d54c8bfb4542"
  },
  {
    "url": "manifest.webmanifest",
    "revision": "6247ab2b7987698b7f554cf4d63febfc"
  }
], {});
workbox_precaching_cleanupOutdatedCaches();
workbox_routing_registerRoute(new workbox_routing_NavigationRoute(workbox_precaching_createHandlerBoundToURL("index.html")));


workbox_routing_registerRoute(/\.(?:js|css)$/, new workbox_strategies_NetworkFirst({ "cacheName":"assets-cache", plugins: [new workbox_expiration_ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 86400 })] }), 'GET');
workbox_routing_registerRoute(({ request }) => request.mode === "navigate", new workbox_strategies_NetworkFirst({ "cacheName":"html-cache", plugins: [new workbox_expiration_ExpirationPlugin({ maxEntries: 5, maxAgeSeconds: 3600 })] }), 'GET');
workbox_routing_registerRoute(/^https?:\/\/.*\/api\/(?!auth\/)/, new workbox_strategies_NetworkFirst({ "cacheName":"api-cache", plugins: [new workbox_expiration_ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 300 })] }), 'GET');




