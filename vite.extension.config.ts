import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import webExtension from "vite-plugin-web-extension";
import { resolve } from "path";
import { patchKaspaWasmForBrowser } from "./build/vite-kaspa-wasm-browser";

const browser = process.env.TARGET_BROWSER || "chrome";
const includeLocalhostMatches = process.env.FORGEOS_EXTENSION_LOCALHOST === "1";
const extraSiteMatches = String(process.env.FORGEOS_EXTENSION_EXTRA_SITE_MATCHES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const SITE_MATCHES = [
  "*://forge-os.xyz/*",
  "*://*.forge-os.xyz/*",
  "*://www.forge-os.xyz/*",
  "*://forgeos.xyz/*",
  "*://www.forgeos.xyz/*",
  "*://gryszzz.github.io/Forge-OS/*",
  "*://forge-os.pages.dev/*",
  ...(includeLocalhostMatches
    ? ["*://localhost/*", "*://127.0.0.1/*"]
    : []),
  ...extraSiteMatches,
];

export default defineConfig({
  // Keep root at the project level so rollup resolves all imports from here.
  plugins: [
    react(),
    patchKaspaWasmForBrowser(),
    webExtension({
      // Provide manifest as a function returning an object so all entry paths
      // can be absolute — avoids CWD-relative resolution issues in sub-builds.
      manifest: () => ({
        manifest_version: 3,
        name: "Forge-OS",
        version: "1.0.1",
        description: "Non-custodial Kaspa wallet — send, receive, DEX & swaps, AI agents. AES-256-GCM + PBKDF2. BIP44. Mainnet, TN10, TN11 & TN12.",
        action: {
          default_popup: "extension/popup/index.html",
          default_icon: { "16": "extension/icons/icon16.png", "48": "extension/icons/icon48.png", "128": "extension/icons/icon128.png" },
        },
        icons: { "16": "extension/icons/icon16.png", "48": "extension/icons/icon48.png", "128": "extension/icons/icon128.png" },
        background: { service_worker: "extension/background/service-worker.ts", type: "module" },
        content_scripts: [
          {
            matches: [
              ...SITE_MATCHES,
            ],
            js: ["extension/content/page-provider.ts"],
            world: "MAIN",
            run_at: "document_start",
          },
          {
            matches: [
              ...SITE_MATCHES,
            ],
            js: ["extension/content/site-bridge.ts"],
            run_at: "document_idle",
          },
        ],
        // Allow WASM instantiation in extension pages (popup, options).
        // 'wasm-unsafe-eval' is required by kaspa-wasm; safe because we only
        // load our own bundled WASM, never remote/user-supplied code.
        content_security_policy: {
          extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
        },
        permissions: ["storage", "alarms", "clipboardWrite", "tabs", "windows"],
        host_permissions: [
          "https://api.kaspa.org/*",
          "https://api-tn10.kaspa.org/*",
          "https://api-tn11.kaspa.org/*",
          "https://api-tn12.kaspa.org/*",
          "https://*.kaspa.org/*",
        ],
      }),
      browser,
      // Prevent sub-builds from loading the main vite.config.ts (manualChunks
      // is incompatible with service worker inlineDynamicImports).
      // Also direct all sub-build outputs to dist-extension/.
      scriptViteConfig: {
        configFile: false,
        plugins: [patchKaspaWasmForBrowser()],
        resolve: { alias: { "../../src": resolve(__dirname, "src") } },
        build: { outDir: resolve(__dirname, "dist-extension") },
      },
      htmlViteConfig: {
        configFile: false,
        plugins: [patchKaspaWasmForBrowser()],
        resolve: { alias: { "../../src": resolve(__dirname, "src") } },
        build: { outDir: resolve(__dirname, "dist-extension") },
      },
    }),
  ],
  resolve: {
    alias: { "../../src": resolve(__dirname, "src") },
  },
  build: {
    outDir: resolve(__dirname, "dist-extension"),
    emptyOutDir: true,
    sourcemap: false,
    // Explicitly clear manualChunks so it doesn't conflict with the service
    // worker sub-build which requires inlineDynamicImports.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
