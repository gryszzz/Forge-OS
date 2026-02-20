#!/usr/bin/env node
import dns from "node:dns/promises";

const domain = (process.argv[2] || "forge-os.xyz").toLowerCase();
const alt = (process.argv[3] || `www.${domain}`).toLowerCase();

const GITHUB_PAGES_A = new Set([
  "185.199.108.153",
  "185.199.109.153",
  "185.199.110.153",
  "185.199.111.153",
]);

const GITHUB_PAGES_AAAA = new Set([
  "2606:50c0:8000::153",
  "2606:50c0:8001::153",
  "2606:50c0:8002::153",
  "2606:50c0:8003::153",
]);

async function resolveSafe(type, host) {
  try {
    const values = await dns.resolve(host, type);
    return { ok: true, values };
  } catch (error) {
    return { ok: false, error: error?.code || error?.message || "UNKNOWN" };
  }
}

async function fetchSafe(url) {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual" });
    const body = await res.text();
    return {
      ok: true,
      status: res.status,
      location: res.headers.get("location") || "",
      server: res.headers.get("server") || "",
      body,
      bodySample: body.slice(0, 500).toLowerCase(),
    };
  } catch (error) {
    return { ok: false, error: error?.message || "HTTP_ERROR" };
  }
}

function extractModuleBootstrap(baseUrl, html) {
  const source = String(html || "");
  const moduleSrcMatch = source.match(
    /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>/i
  );
  if (moduleSrcMatch?.[1]) {
    try {
      return {
        mode: "module-src",
        srcUrl: new URL(moduleSrcMatch[1], baseUrl).toString(),
      };
    } catch {
      // fall through
    }
  }

  const inlineModuleMatch = source.match(/<script[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/i);
  if (inlineModuleMatch?.[1]) {
    return {
      mode: "inline-module",
      code: inlineModuleMatch[1],
    };
  }

  return { mode: "none" };
}

async function loadManifest(baseOrigin) {
  const candidates = [
    `${baseOrigin}/manifest.json`,
    `${baseOrigin}/dist/manifest.json`,
    `${baseOrigin}/Forge.OS/manifest.json`,
    `${baseOrigin}/Forge.OS/dist/manifest.json`,
  ];

  for (const manifestUrl of candidates) {
    const manifestResponse = await fetchSafe(manifestUrl);
    if (!manifestResponse.ok || manifestResponse.status !== 200) {
      continue;
    }

    try {
      const manifest = JSON.parse(manifestResponse.body || "{}");
      if (manifest && typeof manifest === "object" && Object.keys(manifest).length > 0) {
        return { ok: true, manifest, manifestUrl };
      }
    } catch {
      return { ok: false, reason: `manifest parse failed (${manifestUrl})` };
    }
  }

  return { ok: false, reason: "manifest unavailable (all known paths failed)" };
}

async function checkManifestAssets(baseOrigin) {
  const manifestResult = await loadManifest(baseOrigin);
  if (!manifestResult.ok) {
    return { ok: false, reason: manifestResult.reason || "manifest unavailable" };
  }

  const { manifest, manifestUrl } = manifestResult;
  const manifestBaseUrl = String(manifestUrl).endsWith("/manifest.json")
    ? String(manifestUrl).slice(0, -"manifest.json".length)
    : `${baseOrigin}/`;

  const files = [...new Set(Object.values(manifest || {}).map((value) => value?.file).filter(Boolean))];
  if (files.length === 0) {
    return { ok: false, reason: "manifest has no files" };
  }

  const missing = [];
  for (const file of files) {
    const normalized = String(file).replace(/^\//, "");
    const candidateUrls = [
      new URL(normalized, manifestBaseUrl).toString(),
      `${baseOrigin}/${normalized}`,
    ];

    let reachable = false;
    let failureLabel = "";
    for (const assetUrl of candidateUrls) {
      const assetResponse = await fetchSafe(assetUrl);
      if (assetResponse.ok && assetResponse.status === 200) {
        reachable = true;
        break;
      }
      failureLabel = `${assetUrl} (${assetResponse.ok ? assetResponse.status : assetResponse.error})`;
    }

    if (!reachable) {
      missing.push(failureLabel || `${normalized} (unreachable)`);
    }
  }

  return {
    ok: missing.length === 0,
    reason: missing.length > 0 ? `missing assets: ${missing.slice(0, 4).join(", ")}` : "",
    fileCount: files.length,
    manifestUrl,
  };
}

function hasAll(actualValues, expectedSet) {
  const actual = new Set(actualValues);
  for (const value of expectedSet) {
    if (!actual.has(value)) return false;
  }
  return true;
}

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

function normalizeHost(value) {
  return String(value || "").toLowerCase().replace(/\.$/, "");
}

async function main() {
  console.log(`Domain health check for ${domain} (alt: ${alt})`);
  console.log(`Timestamp: ${new Date().toISOString()}`);

  const [ns, a, aaaa, altCname, httpRoot, httpsRoot, httpsWww] = await Promise.all([
    resolveSafe("NS", domain),
    resolveSafe("A", domain),
    resolveSafe("AAAA", domain),
    resolveSafe("CNAME", alt),
    fetchSafe(`http://${domain}`),
    fetchSafe(`https://${domain}`),
    fetchSafe(`https://${alt}`),
  ]);

  printSection("DNS");
  if (ns.ok) console.log(`NS: ${ns.values.join(", ")}`);
  else console.log(`NS: unresolved (${ns.error})`);

  if (a.ok) console.log(`A: ${a.values.join(", ")}`);
  else console.log(`A: unresolved (${a.error})`);

  if (aaaa.ok) console.log(`AAAA: ${aaaa.values.join(", ")}`);
  else console.log(`AAAA: unresolved (${aaaa.error})`);

  if (altCname.ok) console.log(`${alt} CNAME: ${altCname.values.join(", ")}`);
  else console.log(`${alt} CNAME: unresolved (${altCname.error})`);

  printSection("HTTP/HTTPS");
  if (httpRoot.ok) console.log(`http://${domain} -> ${httpRoot.status}${httpRoot.location ? ` (${httpRoot.location})` : ""}`);
  else console.log(`http://${domain} -> error (${httpRoot.error})`);

  if (httpsRoot.ok) console.log(`https://${domain} -> ${httpsRoot.status}${httpsRoot.location ? ` (${httpsRoot.location})` : ""}`);
  else console.log(`https://${domain} -> error (${httpsRoot.error})`);

  if (httpsWww.ok) console.log(`https://${alt} -> ${httpsWww.status}${httpsWww.location ? ` (${httpsWww.location})` : ""}`);
  else console.log(`https://${alt} -> error (${httpsWww.error})`);

  printSection("App Artifact Integrity");
  const bootstrap = httpsRoot.ok ? extractModuleBootstrap(`https://${domain}`, httpsRoot.body) : { mode: "none" };
  const moduleEntryUrl = bootstrap.mode === "module-src" ? bootstrap.srcUrl : null;
  let moduleEntryLeak = false;
  let inlineModuleReady = false;
  if (bootstrap.mode === "none") {
    console.log("Module entry script tag found: NO");
  } else if (bootstrap.mode === "inline-module") {
    const code = String(bootstrap.code || "");
    inlineModuleReady = code.includes("manifest") || code.includes("import(");
    moduleEntryLeak = code.includes("127.0.0.1") || code.includes("localhost");
    console.log(`Bootstrap mode: inline-module (${inlineModuleReady ? "recognized" : "unrecognized"})`);
    console.log(`Localhost/module-dev leak in inline bootstrap: ${moduleEntryLeak ? "YES (ERROR)" : "NO"}`);
  } else {
    console.log(`Module entry script: ${moduleEntryUrl}`);
    const entryResponse = await fetchSafe(moduleEntryUrl);
    const entryOk = entryResponse.ok && entryResponse.status === 200;
    moduleEntryLeak =
      entryResponse.ok &&
      (entryResponse.bodySample.includes("127.0.0.1") || entryResponse.bodySample.includes("src/main.tsx"));
    console.log(`Entry script reachable: ${entryOk ? "YES" : `NO (${entryResponse.ok ? entryResponse.status : entryResponse.error})`}`);
    console.log(`Localhost/module-dev leak in entry: ${moduleEntryLeak ? "YES (ERROR)" : "NO"}`);
  }

  const manifestCheck = await checkManifestAssets(`https://${domain}`);
  console.log(
    `Manifest and asset graph healthy: ${
      manifestCheck.ok
        ? `YES (${manifestCheck.fileCount} files via ${manifestCheck.manifestUrl})`
        : `NO (${manifestCheck.reason})`
    }`
  );

  printSection("Readiness");
  const aReady = a.ok && hasAll(a.values, GITHUB_PAGES_A);
  const aaaaReady = aaaa.ok && hasAll(aaaa.values, GITHUB_PAGES_AAAA);
  const cnameReady =
    altCname.ok && altCname.values.some((v) => normalizeHost(v) === "gryszzz.github.io");
  const httpsReady = httpsRoot.ok && httpsRoot.status >= 200 && httpsRoot.status < 500;
  const moduleEntryReady =
    (bootstrap.mode === "module-src" && Boolean(moduleEntryUrl)) ||
    (bootstrap.mode === "inline-module" && inlineModuleReady);
  const manifestReady = manifestCheck.ok;
  const localhostLeak = moduleEntryLeak;

  console.log(`A records match GitHub Pages: ${aReady ? "YES" : "NO"}`);
  console.log(`AAAA records match GitHub Pages: ${aaaaReady ? "YES" : "NO (optional for launch)"}`);
  console.log(`www CNAME -> gryszzz.github.io: ${cnameReady ? "YES" : "NO"}`);
  console.log(`HTTPS root reachable: ${httpsReady ? "YES" : "NO"}`);
  console.log(`Module entry script present: ${moduleEntryReady ? "YES" : "NO"}`);
  console.log(`Manifest asset graph healthy: ${manifestReady ? "YES" : "NO"}`);

  if (!ns.ok && (a.error === "ENOTFOUND" || a.error === "ENODATA" || a.error === "ENOTIMP")) {
    console.log("Status: Domain delegation appears pending. This is common right after registration.");
    process.exitCode = 2;
    return;
  }

  const hasGitHubNotFoundBody = (sample) => {
    const normalized = String(sample || "").toLowerCase();
    return (
      normalized.includes("there isn't a github pages site here") ||
      normalized.includes("site not found") ||
      normalized.includes("github pages")
    );
  };

  const github404 =
    (httpRoot.ok &&
      httpRoot.status === 404 &&
      /github/i.test(httpRoot.server || "") &&
      hasGitHubNotFoundBody(httpRoot.bodySample)) ||
    (httpsRoot.ok &&
      httpsRoot.status === 404 &&
      /github/i.test(httpsRoot.server || "") &&
      hasGitHubNotFoundBody(httpsRoot.bodySample));

  if (github404) {
    console.log("Status: DNS is routed to GitHub Pages, but custom-domain binding is not active yet.");
    console.log("Action: In GitHub repo Settings -> Pages, set Custom domain to the root domain and save again.");
    console.log("Then wait for certificate issuance and enable Enforce HTTPS.");
    process.exitCode = 1;
    return;
  }

  if (localhostLeak) {
    console.log("Status: App entry appears to reference localhost/dev modules. Rebuild and redeploy production artifacts.");
    process.exitCode = 1;
    return;
  }

  const likelyBranchModeMismatch =
    httpsRoot.ok &&
    String(httpsRoot.body || "").includes("/dist/manifest.json") &&
    !manifestReady;
  if (likelyBranchModeMismatch) {
    console.log("Status: GitHub Pages appears to be serving branch mode content with missing dist assets.");
    console.log("Action: In Settings -> Pages, set Source to GitHub Actions (disable branch-source Pages builds).");
    console.log("Then rerun the 'Deploy ForgeOS to GitHub Pages' workflow.");
    process.exitCode = 1;
    return;
  }

  if (!aReady || !cnameReady || !httpsReady || !moduleEntryReady || !manifestReady) {
    console.log("Status: Partial configuration. See docs/ops/custom-domain.md.");
    process.exitCode = 1;
    return;
  }

  console.log("Status: Domain configuration looks healthy.");
}

main().catch((error) => {
  console.error("Domain health check failed:", error?.message || error);
  process.exitCode = 1;
});
