import kaspaWasmUrl from "kaspa-wasm/kaspa_wasm_bg.wasm?url";

type KaspaModule = Record<string, any>;

declare global {
  // Preloaded bytes consumed by our Vite-patched kaspa-wasm wrapper.
  // eslint-disable-next-line no-var
  var __forgeosKaspaWasmBytes: Uint8Array | ArrayBuffer | undefined;
  // Back-compat key used by older patched wrappers.
  // eslint-disable-next-line no-var
  var __FORGEOS_KASPA_WASM_BYTES__: Uint8Array | ArrayBuffer | undefined;
}

let kaspaModulePromise: Promise<KaspaModule> | null = null;
let kaspaWasmBytesPromise: Promise<void> | null = null;

function getPreloadedKaspaWasmBytes(): Uint8Array | ArrayBuffer | undefined {
  return globalThis.__forgeosKaspaWasmBytes || globalThis.__FORGEOS_KASPA_WASM_BYTES__;
}

function setPreloadedKaspaWasmBytes(bytes: Uint8Array | ArrayBuffer): void {
  globalThis.__forgeosKaspaWasmBytes = bytes;
  globalThis.__FORGEOS_KASPA_WASM_BYTES__ = bytes;
}

function resolveKaspaNamespace(ns: any): KaspaModule {
  if (ns?.Mnemonic) return ns as KaspaModule;
  if (ns?.default?.Mnemonic) return ns.default as KaspaModule;
  if (ns?.k?.Mnemonic) return ns.k as KaspaModule;
  if (ns?.k?.default?.Mnemonic) return ns.k.default as KaspaModule;
  return ns as KaspaModule;
}

async function ensureKaspaWasmBytes(): Promise<void> {
  if (getPreloadedKaspaWasmBytes()) return;

  if (!kaspaWasmBytesPromise) {
    kaspaWasmBytesPromise = (async () => {
      const res = await fetch(kaspaWasmUrl);
      if (!res.ok) {
        throw new Error(`WASM_FETCH_FAILED: ${res.status} ${res.statusText}`);
      }
      const buf = await res.arrayBuffer();
      setPreloadedKaspaWasmBytes(new Uint8Array(buf));
    })().catch((err) => {
      kaspaWasmBytesPromise = null;
      throw err;
    });
  }

  await kaspaWasmBytesPromise;
}

/**
 * Browser-safe kaspa-wasm loader.
 *
 * The published `kaspa-wasm` npm package bootstraps itself using Node's `fs`.
 * Vite patches that wrapper at build time (see `build/vite-kaspa-wasm-browser.ts`)
 * and this loader preloads the wasm bytes before importing the package.
 */
export async function loadKaspaWasm(): Promise<KaspaModule> {
  if (!kaspaModulePromise) {
    kaspaModulePromise = (async () => {
      try {
        await ensureKaspaWasmBytes();
        const ns = await import("kaspa-wasm");
        const kaspa = resolveKaspaNamespace(ns);

        // Some builds expose an init function; call it if present and idempotent.
        const initFn = kaspa.default || kaspa.init;
        if (typeof initFn === "function") {
          try { await initFn(); } catch { /* idempotent in some builds */ }
        }

        return kaspa;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`KASPA_WASM_INIT_FAILED: ${msg}`);
      }
    })().catch((err) => {
      kaspaModulePromise = null;
      throw err;
    });
  }

  return kaspaModulePromise;
}
