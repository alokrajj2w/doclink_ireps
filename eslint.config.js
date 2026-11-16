/**
 * ESLint (flat config) for `npm run lint`.
 *
 * A modest rule set: ESLint's recommended rules, which catch real mistakes (an undefined name,
 * a duplicate key, unreachable code, a misspelt typeof, ...), with the globals of the context
 * each file runs in. It checks no formatting: reformatting the code is a separate step.
 *
 * Errors fail the lint. Warnings (unused variables, imports and functions; a value assigned and
 * never read; ...) are listed for clean-up and never fail it.
 */
import js from "@eslint/js";
import globals from "globals";

/** Run only by the service worker, which has no DOM (no document, window or DOMParser). */
const WORKER_ONLY = ["background/service-worker.js", "background/bill-upload-job.js", "background/keep-alive.js"];
/** Injected into the user's IREPS tab as a plain script (chrome.scripting.executeScript({ files })). */
const TAB_SCRIPT = "background/bill-tab-request.js";
/** The node:test suites stand in for the browser: a fake `chrome` and a jsdom `document` on globalThis. */
const NODE_TESTS = ["tender/tests/**/*.{js,mjs}", "test/node/**/*.mjs"];

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "01_api_data/**",
      "02_recon_engine/**",
      // the IREPS portal's own scripts (jQuery, postRequest.js, CRISPKI.js), served as-is by the mock portal
      "test/mock/static/**",
      "**/fixtures/**"
    ]
  },

  js.configs.recommended,

  {
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    linterOptions: { reportUnusedDisableDirectives: "warn" },
    rules: {
      "no-unused-vars": ["warn", { args: "after-used", caughtErrors: "none", ignoreRestSiblings: true, argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // a defensive initial value that is always overwritten (let html = ""; try { html = ... })
      "no-useless-assignment": "warn",
      // `|| [, ""]` (a match result without its group) is a deliberate hole
      "no-sparse-arrays": "warn",
      "preserve-caught-error": "warn",
      // IREPS text is matched for no-break spaces and control characters on purpose (normaliseText,
      // file-name cleaning); an irregular space in a comment or in code is still an error.
      "no-irregular-whitespace": ["error", { skipStrings: true, skipRegExps: true, skipTemplates: true }],
      "no-control-regex": "off",
      // style, not bugs: left to the formatting step (`== null` is used on purpose)
      "no-useless-escape": "off",
      eqeqeq: "off"
    }
  },

  // The extension: modules shared by the service worker, the offscreen document and the side panel.
  {
    files: ["background/**/*.js", "popup/**/*.js", "pages/**/*.js", "services/**/*.js", "utils/**/*.js", "tender/**/*.js"],
    ignores: [...WORKER_ONLY, TAB_SCRIPT, "tender/tests/**"],
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions } }
  },
  {
    files: WORKER_ONLY,
    languageOptions: { globals: { ...globals.serviceworker, ...globals.webextensions } }
  },
  {
    files: [TAB_SCRIPT],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, ...globals.webextensions } }
  },
  {
    // set by scripts/build.mjs (esbuild define) in a built copy; undefined when DocLink is loaded unpacked
    files: ["utils/logger.js"],
    languageOptions: { globals: { __DOCLINK_LOG_LEVEL__: "readonly" } }
  },

  // The browser test suite (test/run-tests.html imports test/*.js).
  {
    files: ["test/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } }
  },

  // Node: the build and test runner, the mock portal, the node:test suites and this file.
  {
    files: ["**/*.mjs", "scripts/**/*.js", "tender/tests/**/*.js", "eslint.config.js"],
    languageOptions: { globals: globals.node }
  },
  {
    files: NODE_TESTS,
    languageOptions: { globals: { ...globals.node, ...globals.webextensions, document: "readonly" } }
  }
];
