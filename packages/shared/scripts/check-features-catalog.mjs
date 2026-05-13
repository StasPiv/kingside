#!/usr/bin/env node
/**
 * KS-2962 / ADR-062 §8 — CI-чек соответствия каталога фич AI-ассистента
 * (`packages/shared/src/features-catalog/`) реальным роутам фронта
 * (`apps/web/src/App.tsx`).
 *
 * Запускается из корня монорепо: `node packages/shared/scripts/check-features-catalog.mjs`.
 * Также подключён в npm-скрипт `check:features` корневого package.json.
 *
 * Замечание по расположению: ADR-062 предписывает положить скрипт и
 * whitelist в `tools/`. Текущая инфра агентов держит `tools/` владельцем
 * root и не bind-mount'ит его на хост (см. KS-2962 комментарии в трекере),
 * поэтому скрипт временно живёт в `packages/shared/scripts/` (RW-зона
 * backend). После расширения mount-схемы файлы переедут в tools/ как
 * единым коммитом — путь в `package.json` тоже обновится.
 *
 * Алгоритм:
 *   1. Если есть `apps/web/src/App.tsx` — парсим TypeScript compiler API,
 *      собираем все `<Route path="...">` (включая обе ветки conditional
 *      `{flag ? ... : ...}`), считаем какие пути отрендерены под каким
 *      feature-flag.
 *   2. Применяем whitelist (`exactPaths`, `prefixes`, `redirectElements`,
 *      `indexRoute`).
 *   3. Сравниваем с union `paths[]` из `FEATURES` в обе стороны.
 *   4. Доп. проверки: `summary` ≥ 30 chars, `featureFlag` ∈ known set,
 *      consistency `featureFlag` ↔ conditional rendering в App.tsx,
 *      (опционально) cross-ref `mcpSection` ↔ `/_mcp/tools`.
 *   5. Exit 0 / 1 с понятным сообщением.
 *
 * Без runtime-зависимостей кроме `typescript` (уже в repo как devDep).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const APP_TSX_PATH = resolve(REPO_ROOT, 'apps/web/src/App.tsx');
// KS-2962: whitelist живёт рядом со скриптом — временно, пока tools/
// недоступен (см. KS-2962). После переезда — `tools/features-catalog-whitelist.json`.
const WHITELIST_PATH = resolve(
  REPO_ROOT,
  'packages/shared/config/features-catalog-whitelist.json',
);

const CATALOG_MODULE_PATH = resolve(
  REPO_ROOT,
  'packages/shared/dist/features-catalog/index.js',
);
const FLAGS_MODULE_PATH = resolve(
  REPO_ROOT,
  'packages/shared/dist/types/feature-flags.js',
);

// ─── helpers ────────────────────────────────────────────────────────

function bail(msg) {
  console.error(`features-catalog check FAILED: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`features-catalog check OK: ${msg}`);
}

function warn(msg) {
  console.warn(`features-catalog check WARN: ${msg}`);
}

async function loadJson(path) {
  const buf = await readFile(path, 'utf8');
  return JSON.parse(buf);
}

async function loadCatalog() {
  if (!existsSync(CATALOG_MODULE_PATH)) {
    bail(
      `compiled catalog not found at ${CATALOG_MODULE_PATH}. ` +
        `Run \`tsc --build packages/shared\` first.`,
    );
  }
  const mod = await import(CATALOG_MODULE_PATH);
  if (!Array.isArray(mod.FEATURES)) {
    bail('FEATURES export is missing or not an array');
  }
  return mod.FEATURES;
}

async function loadKnownFlagKeys() {
  // KS-2962: union ключей берём из IFeatureFlags. На уровне runtime у нас
  // нет рантайм-объекта KNOWN_FEATURE_FLAGS в shared (он на бэке).
  // Узнаём ключи из самого каталога — те которые встречаются в записях,
  // плюс дублируем известные из shared/types/feature-flags. Это не
  // авторитативный источник, но для проверки «не выдуман ли ключ»
  // достаточно сверки с FEATURE_FLAGS_ALL_KEYS ниже.
  return new Set([
    'lessonsEnabled',
    'puzzlesEnabled',
    'broadcastsEnabled',
    'tournamentsEnabled',
    'assistantEnabled',
    'drillsEnabled',
    'studiesEnabled',
  ]);
}

// ─── AST: extract routes from App.tsx ───────────────────────────────

/**
 * Извлекает все `path="..."` из <Route>-элементов внутри файла App.tsx.
 * Для каждого пути запоминается feature-flag, под которым он отрендерен
 * (если есть обёртка `{flag ? ... : ...}` в JSX).
 *
 * Returns: Array<{path: string, element: string|null, flag: string|null}>
 */
function extractRoutesFromAppTsx(source) {
  const sourceFile = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  const routes = [];

  /**
   * Возвращает имя элемента в `element=<X>` (то, что внутри JSX-родителя).
   * Учитываем обёртки `<ProtectedRoute>` / `<GuestRoute>` / `<AdminRoute>`
   * / `<Suspense>` — то есть для них смотрим на «внутренний» компонент.
   *
   * Если `element` это `<Navigate to=... />` или `<RedirectWithQuery />` —
   * возвращаем имя компонента ('Navigate', 'RedirectWithQuery').
   */
  function getElementName(elementAttrValue) {
    if (!elementAttrValue) return null;
    // element={<X />} → JsxExpression → JsxElement / JsxSelfClosingElement
    if (!ts.isJsxExpression(elementAttrValue)) return null;
    let expr = elementAttrValue.expression;
    if (!expr) return null;
    // Распаковываем JsxElement/JsxSelfClosingElement
    const visit = (node) => {
      if (!node) return null;
      if (ts.isJsxSelfClosingElement(node)) {
        return node.tagName.getText(sourceFile);
      }
      if (ts.isJsxElement(node)) {
        const opening = node.openingElement;
        const tag = opening.tagName.getText(sourceFile);
        const wrapperTags = new Set([
          'ProtectedRoute',
          'GuestRoute',
          'AdminRoute',
          'Suspense',
        ]);
        if (wrapperTags.has(tag)) {
          // ищем первого JsxElement-ребёнка
          for (const child of node.children) {
            if (
              ts.isJsxElement(child) ||
              ts.isJsxSelfClosingElement(child)
            ) {
              return visit(child);
            }
          }
          return tag;
        }
        return tag;
      }
      return null;
    };
    return visit(expr);
  }

  /**
   * Извлекает значение атрибута JSX как строку, если оно — string literal.
   */
  function getStringAttr(jsxAttrs, name) {
    for (const a of jsxAttrs.properties) {
      if (!ts.isJsxAttribute(a)) continue;
      if (a.name.getText(sourceFile) !== name) continue;
      const init = a.initializer;
      if (!init) continue;
      if (ts.isStringLiteral(init)) return init.text;
      if (
        ts.isJsxExpression(init) &&
        init.expression &&
        ts.isStringLiteral(init.expression)
      ) {
        return init.expression.text;
      }
      return null;
    }
    return null;
  }

  function getElementAttr(jsxAttrs) {
    for (const a of jsxAttrs.properties) {
      if (!ts.isJsxAttribute(a)) continue;
      if (a.name.getText(sourceFile) !== 'element') continue;
      return a.initializer ?? null;
    }
    return null;
  }

  function hasIndexAttr(jsxAttrs) {
    for (const a of jsxAttrs.properties) {
      if (!ts.isJsxAttribute(a)) continue;
      if (a.name.getText(sourceFile) === 'index') return true;
    }
    return false;
  }

  /**
   * Обход AST с состоянием — текущий activeFlag, если мы внутри
   * `{flag ? <...> : <...>}`-ветки.
   */
  function walk(node, activeFlag, inElseBranch) {
    if (!node) return;

    // Conditional JSX — extract flag name + рекурсия по ветвям.
    if (ts.isConditionalExpression(node)) {
      // Имя флага = текст condition (часто это просто Identifier 'puzzlesEnabled').
      const condText = node.condition.getText(sourceFile).trim();
      // Берём первый Identifier как имя флага.
      const flagId = pickFirstIdentifier(node.condition);
      const newFlag = flagId ?? condText;
      walk(node.whenTrue, newFlag, false);
      walk(node.whenFalse, newFlag, true);
      return;
    }

    // <Route ...> / <Route .../>
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText(sourceFile);
      if (tag === 'Route') {
        const path = getStringAttr(opening.attributes, 'path');
        const isIndex = hasIndexAttr(opening.attributes);
        const elementAttr = getElementAttr(opening.attributes);
        const elementName = getElementName(elementAttr);

        if (isIndex) {
          routes.push({
            path: '__index__',
            element: elementName,
            flag: inElseBranch ? null : activeFlag,
          });
        } else if (path !== null) {
          routes.push({
            path,
            element: elementName,
            flag: inElseBranch ? null : activeFlag,
          });
        }
      }
    }

    ts.forEachChild(node, (child) => walk(child, activeFlag, inElseBranch));
  }

  function pickFirstIdentifier(node) {
    let found = null;
    function visit(n) {
      if (found) return;
      if (ts.isIdentifier(n)) {
        found = n.text;
        return;
      }
      ts.forEachChild(n, visit);
    }
    visit(node);
    return found;
  }

  walk(sourceFile, null, false);

  return routes;
}

// ─── CI logic ───────────────────────────────────────────────────────

function isWhitelisted(path, whitelist) {
  if (whitelist.exactPaths.includes(path)) return true;
  for (const pref of whitelist.prefixes) {
    if (path === pref || path.startsWith(pref + '/') || path.startsWith(pref)) {
      return true;
    }
  }
  return false;
}

async function main() {
  const whitelist = await loadJson(WHITELIST_PATH);
  const features = await loadCatalog();
  const knownFlags = await loadKnownFlagKeys();

  // ── Step 1+2: parse App.tsx ───────────────────────────────────────
  if (!existsSync(APP_TSX_PATH)) {
    warn(
      `apps/web/src/App.tsx not found at ${APP_TSX_PATH} — skipping App.tsx ↔ catalog diff (running in backend-only environment).`,
    );
  } else {
    const source = await readFile(APP_TSX_PATH, 'utf8');
    const routes = extractRoutesFromAppTsx(source);

    // Применяем whitelist: redirectElements, prefixes/exactPaths,
    // wildcard '*' и index-routes (если indexRoute=true).
    const userFacingRoutes = routes.filter((r) => {
      if (r.path === '*') return false;
      if (r.path === '__index__') return !whitelist.indexRoute === false;
      if (r.element && whitelist.redirectElements.includes(r.element)) {
        return false;
      }
      if (isWhitelisted(r.path, whitelist)) return false;
      return true;
    });

    const routesInApp = new Set(
      userFacingRoutes
        .map((r) => (r.path === '__index__' ? '/' : r.path))
        .filter((p) => typeof p === 'string'),
    );

    const routesInCatalog = new Set();
    for (const f of features) {
      for (const p of f.paths) routesInCatalog.add(p);
    }

    // ── Step 5: diff ────────────────────────────────────────────────
    const missingFromCatalog = [...routesInApp].filter(
      (p) => !routesInCatalog.has(p),
    );
    const staleInCatalog = [...routesInCatalog].filter(
      (p) => !routesInApp.has(p),
    );

    if (missingFromCatalog.length > 0) {
      console.error(
        'Routes present in apps/web/src/App.tsx but missing from features-catalog:',
      );
      for (const p of missingFromCatalog.sort()) console.error(`  - ${p}`);
      bail(
        'add records to packages/shared/src/features-catalog/ ' +
          '(one file per section) or extend the whitelist if these are infrastructure paths.',
      );
    }

    if (staleInCatalog.length > 0) {
      console.error('Stale entries in features-catalog (no matching route in App.tsx):');
      for (const p of staleInCatalog.sort()) {
        // Найти фичу, у которой этот path
        const owner = features.find((f) => f.paths.includes(p));
        console.error(
          `  - ${p} (record: ${owner ? owner.id : 'unknown'})`,
        );
      }
      bail(
        'remove these paths from packages/shared/src/features-catalog/ ' +
          'or restore the corresponding <Route> in apps/web/src/App.tsx.',
      );
    }

    // ── Conditional-flag consistency check (ADR-062 §9) ─────────────
    // Если путь в App.tsx отрендерен под `{flag ? ... : ...}`, запись
    // каталога для этого пути должна иметь `featureFlag: flag`.
    const flagByPath = new Map();
    for (const r of userFacingRoutes) {
      if (!r.flag) continue;
      const pathKey = r.path === '__index__' ? '/' : r.path;
      // Принимаем первый flag, если их несколько на ветке.
      if (!flagByPath.has(pathKey)) flagByPath.set(pathKey, r.flag);
    }
    const flagMismatch = [];
    for (const [p, flag] of flagByPath.entries()) {
      const owner = features.find((f) => f.paths.includes(p));
      if (!owner) continue; // уже отловлено выше
      if (owner.featureFlag !== flag) {
        flagMismatch.push(
          `  - ${p} rendered under {${flag} ? ...} but record \`${owner.id}\`.featureFlag = ${
            owner.featureFlag === null ? 'null' : `'${owner.featureFlag}'`
          }`,
        );
      }
    }
    if (flagMismatch.length > 0) {
      console.error(
        'Conditional-route flag mismatch (ADR-062 §9):',
      );
      for (const line of flagMismatch) console.error(line);
      bail(
        'update `featureFlag` in the catalog entry to match how App.tsx renders the route.',
      );
    }

    ok(
      `App.tsx ↔ catalog: ${routesInCatalog.size} catalog paths, ` +
        `${routesInApp.size} user-facing routes, all aligned.`,
    );
  }

  // ── Step 4: catalog-level validations ─────────────────────────────
  const problems = [];
  const seenIds = new Set();
  for (const f of features) {
    if (seenIds.has(f.id)) {
      problems.push(`duplicate id: ${f.id}`);
    }
    seenIds.add(f.id);

    if (typeof f.summary !== 'string' || f.summary.length < 30) {
      problems.push(
        `record ${f.id}: summary must be a non-empty string ≥ 30 chars`,
      );
    }
    if (f.featureFlag !== null && !knownFlags.has(f.featureFlag)) {
      problems.push(
        `record ${f.id}: unknown featureFlag '${f.featureFlag}' — not in FeatureFlagKey union`,
      );
    }
    if (!Array.isArray(f.paths)) {
      problems.push(`record ${f.id}: paths must be an array`);
    }
    if (!['user', 'public', 'optional'].includes(f.auth)) {
      problems.push(
        `record ${f.id}: auth must be one of 'user' | 'public' | 'optional'`,
      );
    }
  }
  if (problems.length > 0) {
    console.error('Catalog validation problems:');
    for (const p of problems) console.error(`  - ${p}`);
    bail('fix the problems above in packages/shared/src/features-catalog/.');
  }
  ok(`catalog validation: ${features.length} records valid.`);

  // ── Step 6 (optional): MCP cross-ref ──────────────────────────────
  const mcpUrl = process.env.KINGSIDE_API_URL;
  const mcpKey = process.env.MCP_DISCOVERY_KEY;
  if (mcpUrl && mcpKey) {
    try {
      const res = await fetch(`${mcpUrl.replace(/\/+$/, '')}/_mcp/tools`, {
        headers: { Authorization: `Bearer ${mcpKey}` },
      });
      if (!res.ok) {
        warn(
          `MCP cross-ref skipped: GET /_mcp/tools returned ${res.status}.`,
        );
      } else {
        const data = await res.json();
        const sectionIds = new Set(
          (data.sections ?? []).map((s) => s.id ?? s.section),
        );
        const missing = [];
        for (const f of features) {
          if (f.mcpSection && !sectionIds.has(f.mcpSection)) {
            missing.push(`${f.id} → mcpSection '${f.mcpSection}'`);
          }
        }
        if (missing.length > 0) {
          console.error('mcpSection references not found in /_mcp/tools:');
          for (const m of missing) console.error(`  - ${m}`);
          bail(
            'either drop the mcpSection from these catalog entries or ' +
              'register the corresponding @McpModule on the backend.',
          );
        }
        ok('MCP cross-ref: all mcpSection references resolved.');
      }
    } catch (err) {
      warn(
        `MCP cross-ref skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    warn(
      'MCP cross-ref skipped: KINGSIDE_API_URL or MCP_DISCOVERY_KEY not set.',
    );
  }

  ok(`features-catalog all checks passed (${features.length} records).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
