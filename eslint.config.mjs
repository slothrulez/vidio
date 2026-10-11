import nextTs from 'eslint-config-next/typescript';
import nextVitals from 'eslint-config-next/core-web-vitals';
import { defineConfig, globalIgnores } from 'eslint/config';

const syntaxRules = [
  {
    selector: 'JSXOpeningElement[name.name="head"]',
    message:
      'Do not use <head>; use the metadata API. Import third-party CSS and fonts at the top of globals.css or via next/font; use ReactDOM preload/preconnect/dns-prefetch; for JSON-LD see https://nextjs.org/docs/app/guides/json-ld',
  },
];

const nextConfigRestrictedSyntaxRules = [
  {
    selector:
      'Property[key.name=/^(root|outputFileTracingRoot)$/] > Literal[value=/^\\//]',
    message:
      'Do not hardcode absolute paths in next.config; build them with path.resolve(__dirname, ...), import.meta.dirname or process.cwd().',
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'no-restricted-syntax': ['error', ...syntaxRules],
    },
  },
  {
    files: ['next.config.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...nextConfigRestrictedSyntaxRules],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Build artifacts:
    'server.js',
    'dist/**',
    '.vidio/**',
    // Script files (CommonJS):
    'scripts/**/*.js',
  ]),
]);

export default eslintConfig;
