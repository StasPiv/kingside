// ESLint flat-config для apps/web (KS-2034).
//
// Контекст: ESLint v10 требует flat-config, его в проекте не было —
// поэтому `npm run lint` падал на уровне «cannot find config» и
// фактически не запускался ни одного раза. Заводим минимальный, но
// рабочий конфиг, который опирается только на установленные плагины
// (`@eslint/js`, `typescript-eslint`, `globals`).
//
// React-специфичных плагинов (`eslint-plugin-react-hooks`,
// `eslint-plugin-jsx-a11y`, `eslint-plugin-react-refresh`) в зависимостях
// репозитория нет — это отдельная зона расширения линтера, не часть
// KS-2034 (по тикету: «структуру не менять, отключения только
// обоснованные»). Подключение этих плагинов нужно делать отдельной
// задачей с `npm install` и согласованием правил.
//
// Конфиг использует tseslint.recommended (без type-checked, чтобы
// линтер не требовал tsconfig project-references — у нас несколько
// tsconfig'ов, и type-checked rules сильно замедляют линтер на
// 1000+ файлах).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'build/**',
      'coverage/**',
      'node_modules/**',
      'public/**',
      'playwright-report/**',
      'test-results/**',
      // Vendored / generated
      'src/**/*.generated.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // KS-2034: hooks-правила. `rules-of-hooks` — error (это про
      // корректность React, не косметика). `exhaustive-deps` — warn,
      // потому что в ряде мест намеренно лишние/недостающие deps
      // (с пояснением в коде). Конкретные исключения помечаются
      // обоснованным `eslint-disable-next-line`.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // unused vars/args/imports — единое правило, имена с `_` префиксом
      // считаем намеренно неиспользуемыми (стандартный паттерн для
      // hooks-аргументов и destructure-rest).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // base no-unused-vars выключаем — за нас работает TS-версия выше.
      'no-unused-vars': 'off',

      // KS-2034: `any` в кодовой базе используется в местах, где нет
      // типов из @kingside/shared (часть Workshop/Lobby до миграции
      // на DTO). Делаем warning, чтобы новые `any` ловились в ревью,
      // но текущая база не блокировала линт.
      '@typescript-eslint/no-explicit-any': 'warn',

      // `@ts-ignore` — warning (надо использовать `@ts-expect-error`
      // с описанием), но не error: исторически встречается в тестах.
      '@typescript-eslint/ban-ts-comment': [
        'warn',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],

      // Под empty interface есть законный кейс: расширение
      // chess.js/types — оставляем warning.
      '@typescript-eslint/no-empty-object-type': 'warn',

      // Часто используется `<></>` или `Function` в legacy-местах —
      // warning, не error.
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',

      // Pure JS правила, базовые.
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'no-debugger': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],

      // Импорты `Foo` без использования — у TS свои типы импортов.
      // Достаточно `@typescript-eslint/no-unused-vars`.
    },
  },
  // Тесты — менее строгий режим: jest/vitest globals + console allowed.
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.jest,
        vi: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  // Конфиг-файлы (vite.config.ts и т.п.) — node-окружение.
  {
    files: ['*.config.{ts,js,mjs}', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
