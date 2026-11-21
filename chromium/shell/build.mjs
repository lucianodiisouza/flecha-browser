// Builds the shell extension into chromium/shell/dist, or the absolute directory in
// FLECHA_SHELL_OUT, so a test shell never replaces the one a running browser loads.
// `node build.mjs --watch` rebuilds on save; reload the extension (or the sidebar) to see the
// change. No Chromium build involved.
import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { featureEntries, copyFeatureStatic } from './build-features.mjs';
import { buildAdblock } from './build-adblock.mjs';
import { writeManifest } from './build-version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = process.env.FLECHA_SHELL_OUT || path.join(here, 'dist');
if (!path.isAbsolute(out)) throw new Error('FLECHA_SHELL_OUT must be an absolute path.');
const ui = path.join(here, 'ui');

function copyStatic() {
  fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });
  // The shell's own icon, which Chromium shows beside its context menu items (Open in Peek).
  fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
  for (const size of [16, 48, 128]) {
    fs.copyFileSync(path.join(root, `chromium/branding/logo/product_logo_${size}.png`), path.join(out, `icons/${size}.png`));
  }
  for (const f of fs.readdirSync(ui)) if (f.endsWith('.css')) fs.copyFileSync(path.join(ui, f), path.join(out, f));
  fs.copyFileSync(
    path.join(root, 'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2'),
    path.join(out, 'fonts/jetbrains-mono.woff2'),
  );
  // The sidebar page (ui/index.html), pointed at the shell's bundle, once per surface.
  const html = fs
    .readFileSync(path.join(ui, 'index.html'), 'utf8')
    .replace('src="app.js"', 'src="sidebar.js"')
    .replace('<link rel="stylesheet" href="onboarding.css" />', '$&\n    <link rel="stylesheet" href="shell.css" />');
  const pages = { window: 'window.html', panel: 'sidebar.html', newtab: 'newtab.html' };
  for (const [surface, page] of Object.entries(pages)) {
    let pageHtml = html.replace('<html>', `<html data-surface="${surface}">`);
    if (surface === 'window') pageHtml = pageHtml.replace('<title>', '<script src="kind.js"></script>\n    <title>');
    fs.writeFileSync(path.join(out, page), pageHtml);
  }
  fs.copyFileSync(path.join(here, 'shell.css'), path.join(out, 'shell.css'));
  // A Flechinha's frame page is window.html?kind=flechinha; this sends it on to the
  // Flechinha toolbar before the sidebar's code runs.
  fs.writeFileSync(
    path.join(out, 'kind.js'),
    "if (new URLSearchParams(location.search).get('kind') === 'flechinha') location.replace('flechinha.html' + location.search);\n",
  );
  fs.writeFileSync(path.join(out, 'flechinha.html'), fs.readFileSync(path.join(ui, 'flechinha.html'), 'utf8'));
  for (const f of ['settings.html', 'settings-shell.css']) fs.copyFileSync(path.join(here, f), path.join(out, f));
  copyFeatureStatic(out);
  // Last, so the version covers every file above and the bundles.
  writeManifest(path.join(here, 'manifest.json'), out);
}

// These extension-page modules load on first use. Fixed names also work in watch
// mode without leaving obsolete chunks in the versioned shell directory.
const panes = ['tabsPane', 'vsrPane'];
const options = {
  entryPoints: { background: path.join(here, 'background.ts'), sidebar: path.join(here, 'sidebar.ts'), settings: path.join(here, 'settings.ts'), flechinha: path.join(here, 'flechinha.ts'), ...featureEntries,
    ...Object.fromEntries(panes.map(name => [name, path.join(ui, name + '.ts')])) },
  external: panes.map(name => './' + name + '.js'),
  minify: true,
  treeShaking: true,
  bundle: true,
  format: 'esm',
  target: 'chrome140',
  outdir: out,
  logLevel: 'warning',
  plugins: [{ name: 'static', setup: (b) => b.onEnd(copyStatic) }],
};

await buildAdblock(out);

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('shell: watching');
} else {
  await build(options);
}
