/**
 * KS-2962 / ADR-062 §8 — регрессионные тесты на `tools/check-features-catalog.mjs`.
 *
 * Запуск из корня: `node --test tools/check-features-catalog.spec.mjs`.
 * Также в npm-скрипт `test:tools` (см. корневой `package.json`) и
 * подключено в `npm run lint` через `check:features` цепочкой.
 *
 * Покрытие:
 *  - `extractRoutesFromAppTsx`: <Route> внутри <ProtectedRoute><…/></ProtectedRoute>
 *    (KS-2962 false-positive по `/profile`), conditional `{flag ? … : …}`,
 *    `<Route index>`, вложенные `<Route>`-структуры (children в <Routes>).
 *  - `filterUserFacingRoutes`: мягкая фильтрация `redirectElements` —
 *    путь с redirect-обёрткой остаётся, если каталог его описывает;
 *    выбывает, если каталога нет.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRoutesFromAppTsx,
  filterUserFacingRoutes,
  isWhitelisted,
} from './check-features-catalog.mjs';

const DEFAULT_WHITELIST = {
  exactPaths: ['/login', '/register', '/oauth/callback'],
  prefixes: ['/admin', '/dev'],
  redirectElements: [
    'Navigate',
    'RedirectWithQuery',
    'ProfileRedirect',
    'RedirectMyCourse',
    'RedirectMyLesson',
    'InviteRedirect',
  ],
  indexRoute: true,
};

// ── extractRoutesFromAppTsx ────────────────────────────────────────

test('extracts <Route path="/profile"> wrapped in <ProtectedRoute><ProfileRedirect/></ProtectedRoute>', () => {
  const source = `
    import { Routes, Route } from 'react-router-dom';
    export default function App() {
      return (
        <Routes>
          <Route path="/profile" element={<ProtectedRoute><ProfileRedirect/></ProtectedRoute>} />
        </Routes>
      );
    }
  `;
  const routes = extractRoutesFromAppTsx(source);
  const profile = routes.find((r) => r.path === '/profile');
  assert.ok(profile, 'route /profile must be detected, not swallowed by ProtectedRoute wrapper');
  assert.equal(profile.element, 'ProfileRedirect', 'wrapper must be unwrapped to inner element');
});

test('extracts <Route> nested under <Routes> with various wrappers', () => {
  const source = `
    <Routes>
      <Route path="/play" element={<ProtectedRoute><PlayPage/></ProtectedRoute>} />
      <Route path="/game/:id" element={<ProtectedRoute><Suspense fallback={null}><GamePage/></Suspense></ProtectedRoute>} />
      <Route path="/about" element={<AboutPage/>} />
      <Route path="*" element={<NotFound/>} />
    </Routes>
  `;
  const routes = extractRoutesFromAppTsx(source);
  const byPath = Object.fromEntries(routes.map((r) => [r.path, r]));
  assert.ok(byPath['/play'], '/play extracted');
  assert.equal(byPath['/play'].element, 'PlayPage');
  assert.ok(byPath['/game/:id'], '/game/:id extracted');
  assert.equal(byPath['/game/:id'].element, 'GamePage', 'unwraps ProtectedRoute → Suspense → GamePage');
  assert.ok(byPath['/about']);
  assert.equal(byPath['/about'].element, 'AboutPage');
  assert.ok(byPath['*'], 'wildcard captured (will be filtered later)');
});

test('extracts <Route index> as __index__ marker', () => {
  const source = `
    <Routes>
      <Route index element={<HomePage/>} />
      <Route path="/features" element={<FeaturesPage/>} />
    </Routes>
  `;
  const routes = extractRoutesFromAppTsx(source);
  const idx = routes.find((r) => r.path === '__index__');
  assert.ok(idx, '<Route index> recorded as __index__');
  assert.equal(idx.element, 'HomePage');
});

test('extracts conditional {flag ? <Route/> : <Navigate/>} branches with flag attribution', () => {
  const source = `
    <Routes>
      {puzzlesEnabled ? (
        <>
          <Route path="/puzzles" element={<ProtectedRoute><PuzzlesPage/></ProtectedRoute>} />
          <Route path="/puzzle-rush" element={<ProtectedRoute><PuzzleRushPage/></ProtectedRoute>} />
        </>
      ) : (
        <>
          <Route path="/puzzles" element={<Navigate to="/" />} />
          <Route path="/puzzle-rush" element={<Navigate to="/" />} />
        </>
      )}
    </Routes>
  `;
  const routes = extractRoutesFromAppTsx(source);
  const puzzlesThen = routes.find(
    (r) => r.path === '/puzzles' && r.element === 'PuzzlesPage',
  );
  const puzzlesElse = routes.find(
    (r) => r.path === '/puzzles' && r.element === 'Navigate',
  );
  assert.ok(puzzlesThen, 'then-branch /puzzles detected');
  assert.equal(puzzlesThen.flag, 'puzzlesEnabled', 'then-branch tagged with flag');
  assert.ok(puzzlesElse, 'else-branch /puzzles (Navigate fallback) detected');
  assert.equal(puzzlesElse.flag, null, 'else-branch flag stripped (inElseBranch)');
});

// ── filterUserFacingRoutes ─────────────────────────────────────────

test('redirectElements filter: ProfileRedirect on /profile is KEPT when catalog has /profile', () => {
  const routes = [
    { path: '/profile', element: 'ProfileRedirect', flag: null },
    { path: '/legacy-old', element: 'Navigate', flag: null },
  ];
  const catalogPaths = new Set(['/profile']);
  const userFacing = filterUserFacingRoutes(routes, DEFAULT_WHITELIST, catalogPaths);
  const paths = userFacing.map((r) => r.path);
  assert.deepEqual(paths, ['/profile'], 'redirect-wrapped path in catalog stays; legacy Navigate is filtered');
});

test('redirectElements filter: ProfileRedirect on /profile is FILTERED when catalog is empty (legacy semantics for unknown paths)', () => {
  const routes = [{ path: '/profile', element: 'ProfileRedirect', flag: null }];
  const catalogPaths = new Set();
  const userFacing = filterUserFacingRoutes(routes, DEFAULT_WHITELIST, catalogPaths);
  assert.equal(userFacing.length, 0, 'no catalog entry → filter out, never raise missing-from-catalog');
});

test('wildcard * is always filtered', () => {
  const routes = [{ path: '*', element: 'NotFound', flag: null }];
  const userFacing = filterUserFacingRoutes(routes, DEFAULT_WHITELIST, new Set());
  assert.equal(userFacing.length, 0);
});

test('exactPaths and prefixes whitelist work', () => {
  const routes = [
    { path: '/login', element: 'LoginPage', flag: null },
    { path: '/admin/feature-flags', element: 'AdminFlags', flag: null },
    { path: '/dev/debug', element: 'DevPage', flag: null },
    { path: '/public', element: 'PublicPage', flag: null },
  ];
  const userFacing = filterUserFacingRoutes(routes, DEFAULT_WHITELIST, new Set());
  const paths = userFacing.map((r) => r.path);
  assert.deepEqual(paths, ['/public'], 'login + admin/* + dev/* filtered, /public stays');
});

test('indexRoute: true keeps __index__ marker for mapping to /', () => {
  const routes = [{ path: '__index__', element: 'HomePage', flag: null }];
  const userFacing = filterUserFacingRoutes(
    routes,
    { ...DEFAULT_WHITELIST, indexRoute: true },
    new Set(['/']),
  );
  assert.equal(userFacing.length, 1, 'kept');
  assert.equal(userFacing[0].path, '__index__', 'caller maps __index__ → / downstream');
});

test('indexRoute: false drops __index__', () => {
  const routes = [{ path: '__index__', element: 'SystemIndex', flag: null }];
  const userFacing = filterUserFacingRoutes(
    routes,
    { ...DEFAULT_WHITELIST, indexRoute: false },
    new Set(),
  );
  assert.equal(userFacing.length, 0);
});

// ── isWhitelisted ──────────────────────────────────────────────────

test('isWhitelisted matches exactPaths and prefixes', () => {
  assert.equal(isWhitelisted('/login', DEFAULT_WHITELIST), true);
  assert.equal(isWhitelisted('/admin', DEFAULT_WHITELIST), true);
  assert.equal(isWhitelisted('/admin/users', DEFAULT_WHITELIST), true);
  assert.equal(isWhitelisted('/dev/debug', DEFAULT_WHITELIST), true);
  assert.equal(isWhitelisted('/profile', DEFAULT_WHITELIST), false);
  assert.equal(isWhitelisted('/login/extra', DEFAULT_WHITELIST), false, 'exact match only for exactPaths');
});
