import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Линтер держит то, что не ловят ни типы, ни тесты: забытый await, недостижимый
 * код, переменную, объявленную и не использованную. Правила оформления сюда не
 * входят намеренно: автоматического форматтера в проекте нет, отступы и переносы
 * расставлены руками — там, где они помогают читать, а не там, где велит ширина.
 *
 * Набор — рекомендованный, без проверок, требующих типов: они на порядок
 * медленнее, а `npm run typecheck` и так проходит по всему дереву.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'release/**', '.dubpipe/**', 'src/ui/public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      /*
       * Неиспользованное имя — почти всегда след недоделанной правки. Исключение
       * одно: аргумент, который нужен позиционно, но не по смыслу; такие в
       * проекте называются с подчёркивания.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Приведение типа — осознанный приём в разборе чужого JSON; ругаться не на что.
      '@typescript-eslint/no-explicit-any': 'off',
      // Пустой catch в проекте всегда с объяснением, почему молчим.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Страница интерфейса — обычный браузерный JavaScript без модулей.
    files: ['src/ui/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser }, sourceType: 'script' },
  },
  {
    // Сценарии проверок и оболочка Electron — CommonJS: require там по делу.
    files: ['scripts/**/*.cjs', 'electron/**/*.cjs'],
    languageOptions: { globals: { ...globals.node }, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node }, sourceType: 'module' },
  },
);
