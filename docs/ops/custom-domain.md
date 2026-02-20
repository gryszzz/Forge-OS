# Custom Domain Operations (forge-os.xyz)

This runbook is for GitHub Pages custom domain cutover and incident response.

## Target State
- Root domain: `forge-os.xyz`
- Alternate name: `www.forge-os.xyz`
- GitHub Pages project URL remains available: `https://gryszzz.github.io/Forge.OS/`

## DNS Records (Name.com)
Set these records:

1. Apex A records (`Host` blank or `@`):
- `185.199.108.153`
- `185.199.109.153`
- `185.199.110.153`
- `185.199.111.153`

2. Apex AAAA records (optional for launch):
- `2606:50c0:8000::153`
- `2606:50c0:8001::153`
- `2606:50c0:8002::153`
- `2606:50c0:8003::153`

3. `www` record:
- Type: `CNAME`
- Host: `www`
- Answer: `gryszzz.github.io`

If Name.com rejects AAAA input, continue with A records and CNAME; IPv4 launch is valid.

## GitHub Settings
In repository `Settings -> Pages`:
1. Source: **GitHub Actions** (required; do not use branch source)
2. Custom domain: `forge-os.xyz`
3. Enable `Enforce HTTPS` once certificate is issued.

`public/CNAME` is committed and workflow copies it into `dist/CNAME` automatically.

## Verify
Run from repo root:

```bash
npm run domain:check
```

Auto-watch (every 10 minutes by default):

```bash
npm run domain:watch
```

Override watch cadence:

```bash
DOMAIN_WATCH_INTERVAL_MINUTES=5 DOMAIN_WATCH_MAX_CHECKS=48 npm run domain:watch
```

Expected healthy output:
- `A records match GitHub Pages: YES`
- `www CNAME -> gryszzz.github.io: YES`
- `HTTPS root reachable: YES`
- `Status: Domain configuration looks healthy.`

## InvalidDNSError Troubleshooting
If GitHub Pages shows `InvalidDNSError`:

1. Check registration/delegation timing.
- Fresh registrations may return `NXDOMAIN` for 15-120+ minutes.

2. Ensure the `www` CNAME exists and no conflicts.
- Remove `www` A/AAAA/redirect records.

3. Confirm apex A records exactly match GitHub Pages.

4. Wait and retry after DNS TTL/registry propagation.

5. If DNS resolves but you get GitHub 404 page ("There isn't a GitHub Pages site here"):
- Re-save `forge-os.xyz` in GitHub `Settings -> Pages -> Custom domain`.
- Wait for cert issuance, then enable `Enforce HTTPS`.

6. If app HTML loads but module chunks 404 (or you see `Importing module script failed`):
- Check Actions tab for a workflow named `pages build and deployment`.
- If that workflow is present, Pages is still in branch mode.
- Fix: `Settings -> Pages -> Source -> GitHub Actions`.
- Rerun `Deploy ForgeOS to GitHub Pages`.

7. If still unresolved after several hours, contact registrar support and ask:
- “Please confirm delegation for `forge-os.xyz` is published in `.xyz` registry.”

## Notes
- This repo’s deploy pipeline automatically switches base path:
- Custom domain present (`public/CNAME`) -> `/`
- No custom domain -> `/${repository-name}/`
