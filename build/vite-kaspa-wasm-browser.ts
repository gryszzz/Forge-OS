import type { Plugin } from "vite";

const KASPA_WASM_ENTRY_RE = /[\\/]node_modules[\\/]kaspa-wasm[\\/]kaspa_wasm\.js$/;

const UTIL_REQUIRE_SNIPPET = "const { TextDecoder, TextEncoder, inspect } = require(`util`);";
const UTIL_BROWSER_SNIPPET = [
  "const { TextDecoder, TextEncoder } = globalThis;",
  "const inspect = { custom: Symbol.for('nodejs.util.inspect.custom') };",
].join("\n");

const WASM_BOOTSTRAP_SNIPPET = [
  "const path = require('path').join(__dirname, 'kaspa_wasm_bg.wasm');",
  "const bytes = require('fs').readFileSync(path);",
  "",
  "const wasmModule = new WebAssembly.Module(bytes);",
].join("\n");

const WASM_BROWSER_BOOTSTRAP_SNIPPET = [
  "const bytes = globalThis.__forgeosKaspaWasmBytes || globalThis.__FORGEOS_KASPA_WASM_BYTES__;",
  "if (!(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) {",
    "    throw new Error('KASPA_WASM_BYTES_MISSING: preload kaspa_wasm_bg.wasm before importing kaspa-wasm');",
  "}",
  "",
  "const wasmModule = new WebAssembly.Module(bytes);",
].join("\n");

/**
 * Patch the published kaspa-wasm npm wrapper (Node/CJS + fs.readFileSync)
 * into a browser-safe variant that consumes preloaded WASM bytes from
 * globalThis.__forgeosKaspaWasmBytes.
 */
export function patchKaspaWasmForBrowser(): Plugin {
  return {
    name: "forgeos:patch-kaspa-wasm-browser",
    enforce: "pre",
    transform(code, id) {
      if (!KASPA_WASM_ENTRY_RE.test(id)) return null;

      let patched = code;
      patched = patched.replace(UTIL_REQUIRE_SNIPPET, UTIL_BROWSER_SNIPPET);
      patched = patched.replace(WASM_BOOTSTRAP_SNIPPET, WASM_BROWSER_BOOTSTRAP_SNIPPET);

      const utilPatched = patched.includes(UTIL_BROWSER_SNIPPET);
      const wasmPatched = patched.includes("KASPA_WASM_BYTES_MISSING");

      if (!utilPatched || !wasmPatched) {
        this.error(
          "Failed to patch kaspa-wasm browser bootstrap. The upstream package format may have changed.",
        );
      }

      return { code: patched, map: null };
    },
  };
}
