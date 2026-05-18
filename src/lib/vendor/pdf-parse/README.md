# pdf-parse (vendored)

This directory is a **vendored copy** of the [`pdf-parse`](https://www.npmjs.com/package/pdf-parse) npm package by Modesty Zhang, originally licensed under MIT (see [`LICENSE`](./LICENSE)).

## Why vendored

The upstream `pdf-parse` package executes a small smoke test at startup via `require('./test/data/05-versions-space.pdf')`. Under Next.js's server-component bundling, that path is rewritten and the file disappears — Orchestra would otherwise crash with `ENOENT: ...05-versions-space.pdf` whenever the knowledge loader pipeline touched a PDF.

The vendored copy drops that startup smoke-test and is otherwise byte-for-byte identical to the upstream release. The modification is documented inline (see `index.js`).

## Upstream

- npm: <https://www.npmjs.com/package/pdf-parse>
- License: MIT (preserved verbatim in [`LICENSE`](./LICENSE))

If a future upstream release fixes the bundler conflict, switch back to the npm dependency and delete this directory.
