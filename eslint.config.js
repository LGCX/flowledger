import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// CONVENTIONS §3 dependency direction. A package may import only what its row allows;
// `testkit` may import anything, and no package may import from `apps/`.
const PACKAGE_DIRS = [
  'config',
  'contracts',
  'domain',
  'database',
  'messaging',
  'providers',
  'observability',
  'testkit',
];

const internal = (dir) => `@flowledger/${dir}`;

const FORBIDDEN_PACKAGES = {
  domain: PACKAGE_DIRS.filter((d) => d !== 'domain').map(internal),
  contracts: PACKAGE_DIRS.filter((d) => d !== 'contracts').map(internal),
  config: PACKAGE_DIRS.filter((d) => d !== 'config').map(internal),
  observability: PACKAGE_DIRS.filter((d) => d !== 'observability').map(internal),
  database: ['messaging', 'providers', 'testkit'].map(internal),
  messaging: ['domain', 'providers', 'testkit'].map(internal),
  providers: ['database', 'messaging', 'testkit'].map(internal),
  testkit: [],
};

const APP_ESCAPES = ['@flowledger/app-*', '@flowledger/app-*/*', '**/apps/**'];

const boundaryConfigs = PACKAGE_DIRS.map((dir) => ({
  files: [`packages/${dir}/src/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          ...FORBIDDEN_PACKAGES[dir].flatMap((name) => [
            { group: [name], message: `${dir} must not import ${name} (CONVENTIONS §3).` },
            { group: [`${name}/*`], message: `${dir} must not import ${name} (CONVENTIONS §3).` },
          ]),
          {
            group: APP_ESCAPES,
            message: 'Packages must not import from apps/ (CONVENTIONS §3).',
          },
        ],
      },
    ],
  },
}));

const MSG_SIMULATOR_TRUTH = 'Simulator ground truth is harness-only (CONVENTIONS §16).';
const MSG_SIMULATOR_OWNER =
  'The provider simulator owner URL is confined to apps/provider-simulator (CONVENTIONS §16).';
const MSG_MONEY = 'Money code uses bigint only (docs/02 §Money representation).';
const MSG_LEDGER = 'Ledger rows are written only by protected SQL functions (ADR-0007).';

const envVarSelectors = (name, message) => [
  { selector: `MemberExpression[property.name='${name}']`, message },
  { selector: `Literal[value='${name}']`, message },
];

const SIMULATOR_TRUTH_SELECTORS = envVarSelectors('SIMULATOR_DATABASE_URL', MSG_SIMULATOR_TRUTH);
const SIMULATOR_OWNER_SELECTORS = envVarSelectors(
  'PROVIDER_SIMULATOR_DATABASE_URL',
  MSG_SIMULATOR_OWNER,
);

const MONEY_SELECTORS = [
  { selector: 'TSNumberKeyword', message: MSG_MONEY },
  { selector: "CallExpression[callee.name='Number']", message: MSG_MONEY },
  { selector: "CallExpression[callee.name='parseInt']", message: MSG_MONEY },
  { selector: "CallExpression[callee.name='parseFloat']", message: MSG_MONEY },
  { selector: "MemberExpression[object.name='Math']", message: MSG_MONEY },
  { selector: 'Literal[raw=/^\\d*\\.\\d/]', message: MSG_MONEY },
];

const LEDGER_DML = '\\b(insert\\s+into|update|delete\\s+from|truncate(\\s+table)?)\\s+ledger\\.';

const LEDGER_SELECTORS = [
  { selector: `Literal[value=/${LEDGER_DML}/i]`, message: MSG_LEDGER },
  { selector: `TemplateElement[value.raw=/${LEDGER_DML}/i]`, message: MSG_LEDGER },
];

// Each config below carries a COMPLETE selector set for the files it matches. In flat
// config the last matching config replaces `no-restricted-syntax` wholesale, so a
// narrower config that lists only its own selectors would silently drop the rest.
const syntaxConfigs = [
  {
    files: ['packages/**/*.ts'],
    ignores: ['packages/testkit/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...SIMULATOR_TRUTH_SELECTORS,
        ...SIMULATOR_OWNER_SELECTORS,
        ...LEDGER_SELECTORS,
      ],
    },
  },
  {
    files: ['packages/domain/src/money.ts', 'packages/domain/src/fees.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...SIMULATOR_TRUTH_SELECTORS,
        ...SIMULATOR_OWNER_SELECTORS,
        ...LEDGER_SELECTORS,
        ...MONEY_SELECTORS,
      ],
    },
  },
  {
    files: ['apps/**/*.ts'],
    ignores: ['apps/cli/**', 'apps/provider-simulator/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...SIMULATOR_TRUTH_SELECTORS,
        ...SIMULATOR_OWNER_SELECTORS,
        ...LEDGER_SELECTORS,
      ],
    },
  },
  {
    files: ['apps/cli/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...SIMULATOR_OWNER_SELECTORS, ...LEDGER_SELECTORS],
    },
  },
  {
    files: ['apps/provider-simulator/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...SIMULATOR_TRUTH_SELECTORS, ...LEDGER_SELECTORS],
    },
  },
];

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/contracts/src/generated/**',
      'coverage/**',
      'reports/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...boundaryConfigs,
  ...syntaxConfigs,
];
