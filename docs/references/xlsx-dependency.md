# Non-npm Dependency: xlsx from the SheetJS CDN

> Level 2 reference for [`CLAUDE.md`](../../CLAUDE.md). Moved **verbatim** 2026-08-02 — the text below is the original, unmodified.
> **Read this when:** bumping xlsx, or a build fails because cdn.sheetjs.com is unreachable

---

### 11. Non-npm dependency: `xlsx` from SheetJS CDN
- `xlsx` in `package.json` resolves to `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, NOT the npm registry. SheetJS stopped publishing to npm in 2023; the last npm-published version (0.18.5) carries two high-severity CVEs (prototype pollution GHSA-4r6h-8v6p-xvw6 and ReDoS GHSA-5pgg-2g8v-p4x9). The CDN tarball is the maintainer's recommended install path and ships the patched 0.20.3.
- The lockfile pins the resolved URL + a SHA-512 integrity hash. CI installs and clean `npm install` work exactly the same as registry packages, with one caveat: **the build host must be able to reach `cdn.sheetjs.com` outbound**. Air-gapped / proxy-restricted environments need either a local mirror of the tarball or a pre-populated `npm cache`. Document this requirement in any deployment runbook.
- **API surface used (verify still present before next bump):** `XLSX.read(buffer, { type: "buffer" })`, `workbook.SheetNames`, `workbook.Sheets[name]`, `XLSX.utils.sheet_to_csv(sheet, { FS, RS })` in [`src/lib/memory/loaders/xlsx-loader.ts`](src/lib/memory/loaders/xlsx-loader.ts). Tests also use `XLSX.utils.book_new`, `XLSX.utils.aoa_to_sheet`, `XLSX.utils.book_append_sheet`, `XLSX.write`.
- **If you ever need to bump:** check `https://docs.sheetjs.com/docs/getting-started/installation/nodejs` for the latest CDN URL, install via `npm install <url>`, run the xlsx-loader test suite, run a non-ASCII round-trip (PM #18 Cyrillic/CJK/emoji) as the loader's regression guard.

---

