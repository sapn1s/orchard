# public/vendor

Third-party browser bundles vendored so the dashboard renders **offline** (this
is a localhost app — no CDN, no network at runtime).

## mermaid.min.js

- **What:** the standalone UMD build of [mermaid](https://mermaid.js.org/) —
  self-contained (zero dynamic imports; all diagram types bundled), attaches
  `globalThis.mermaid`.
- **Why vendored:** FEAT-075's in-app Guide reader renders the `docs/guide/`
  `` ```mermaid `` diagrams client-side. It is lazy-loaded (only when a guide
  page with a diagram is opened) from this local file — never a CDN.
- **License:** MIT (see the license banner at the tail of the file).
- **Version:** mermaid 11.16.1.
- **Refresh:** `npm pack mermaid@<version>` → extract `package/dist/mermaid.min.js`
  → copy here. Do not edit by hand.
