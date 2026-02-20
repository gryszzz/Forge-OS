import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const manifestPath = "dist/manifest.json";
const targetManifestPath = "manifest.json";
const targetAssetsDir = "assets";

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const files = [...new Set(
  Object.values(manifest).flatMap((entry) => {
    const list = [];
    if(entry?.file) list.push(entry.file);
    if(Array.isArray(entry?.css)) list.push(...entry.css);
    return list;
  }).filter(Boolean)
)];

rmSync(targetAssetsDir, { recursive: true, force: true });
mkdirSync(targetAssetsDir, { recursive: true });

for(const relFile of files) {
  const src = path.join("dist", relFile);
  const dest = relFile;
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

writeFileSync(targetManifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`[sync-pages-fallback] Synced ${files.length} asset files + ${targetManifestPath}`);
