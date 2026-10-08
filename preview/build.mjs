// Bundle the preview harness: `npm run preview`, then open preview/out/index.html.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Under node_modules on purpose: it is build output, and the public-SDK scan
// (rightly) skips node_modules rather than reading minified bundles.
const out = join(root, "node_modules", ".preview");
mkdirSync(out, { recursive: true });

await build({
  entryPoints: { bundle: join(root, "preview", "main.tsx"), "bench-bundle": join(root, "preview", "bench.tsx") },
  bundle: true,
  outdir: out,
  format: "iife",
  jsx: "automatic",
  target: "es2022",
  sourcemap: false,
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"development"' },
});

// The host's theme tokens, faked closely enough to judge contrast in both modes.
writeFileSync(
  join(out, "index.html"),
  `<!doctype html>
<meta charset="utf-8">
<title>Bot Stage preview</title>
<link rel="stylesheet" href="bundle.css">
<style>
  :root { --radius: .625rem; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  .pv[data-theme="light"] {
    --background:#ffffff; --foreground:#1a1d1b; --muted-foreground:#6b726e; --border:#e4e7e5;
    --sidebar:#f6f7f6; --sidebar-foreground:#1a1d1b; --sidebar-border:#e1e4e2; --sidebar-accent:#ebeeec; --destructive:#d93f45;
  }
  .pv[data-theme="dark"] {
    --background:#141716; --foreground:#e8ece9; --muted-foreground:#8d9792; --border:#2a2f2d;
    --sidebar:#1b1f1d; --sidebar-foreground:#e8ece9; --sidebar-border:#2c322f; --sidebar-accent:#262b29; --destructive:#ee5a5f;
  }
  body { margin:0; background: var(--background, #fff); }
  .pv { display:flex; min-height:100vh; background: var(--background); color: var(--foreground); }
  .pv-sidebar { width: 303px; flex:none; background: var(--sidebar); border-right:1px solid var(--sidebar-border); padding-top: 24px; box-sizing:border-box; }
  .pv-main { flex:1; min-width:0; }
</style>
<div id="root"></div>
<script src="bundle.js"></script>
`,
);
writeFileSync(
  join(out, "bench.html"),
  `<!doctype html>
<meta charset="utf-8">
<title>Bot Stage bench</title>
<link rel="stylesheet" href="bench-bundle.css">
<style>:root{--sidebar:#1b1f1d;--sidebar-foreground:#e8ece9;--sidebar-border:#2c322f;--sidebar-accent:#262b29;--muted-foreground:#8d9792;--destructive:#ee5a5f;}body{margin:0;background:#1b1f1d;color:#e8ece9}</style>
<div id="root"></div>
<script src="bench-bundle.js"></script>
`,
);
console.log("preview ready:", join(out, "index.html"));
