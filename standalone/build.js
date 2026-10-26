// Builds the standalone (serverless) edition into dist/ — the same server code, running in the browser on sql.js.
//   npm run build:standalone      → dist/   (deployable to GitHub Pages / any static host)
const esbuild = require('esbuild'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..'), dist = path.join(root, 'dist'), sh = n => path.join(__dirname, 'shims', n + '.js');
const copy = (from, to) => fs.cpSync(from, to, { recursive: true });
(async () => {
  fs.rmSync(dist, { recursive: true, force: true }); fs.mkdirSync(dist, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'entry-server.js')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', outfile: path.join(dist, 'erp-server.js'), minify: true, legalComments: 'none', logLevel: 'warning',
    alias: { 'node:sqlite': sh('sqlite'), 'node:crypto': sh('crypto'), 'node:fs': sh('fs'), 'node:path': sh('path'), 'node:http': sh('http'), 'node:net': sh('net'), 'node:tls': sh('tls'), 'node:child_process': sh('child_process'), 'node:os': sh('os'), 'node:zlib': sh('zlib') },
    inject: [sh('inject')], define: { __dirname: '"/app"', __filename: '"/app/server.js"' },
  });
  copy(path.join(root, 'public'), dist);                                           // the application UI
  copy(path.join(root, 'brand'), path.join(dist, 'brand'));                        // brand pack (installed by the "brand pack" button)
  for (const f of ['stamp.svg', 'stamp.png']) fs.rmSync(path.join(dist, 'brand', f), { force: true });   // the official stamp must never be published: upload it from Settings instead
  const sqljs = path.join(root, 'node_modules', 'sql.js', 'dist');
  fs.copyFileSync(path.join(sqljs, 'sql-wasm.js'), path.join(dist, 'sql-wasm.js')); fs.copyFileSync(path.join(sqljs, 'sql-wasm.wasm'), path.join(dist, 'sql-wasm.wasm'));
  for (const f of fs.readdirSync(path.join(__dirname, 'runtime'))) fs.copyFileSync(path.join(__dirname, 'runtime', f), path.join(dist, f));
  // page: load the runtime first, start the app only when the local database is ready
  let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  html = html.replace('<script src="app.js"></script>', '<script src="standalone-runtime.js"></script>\n<script src="standalone-cloud.js"></script>\n<script src="app.js"></script>').replace('<script src="boot.js"></script>', '<script src="standalone-ui.js"></script>\n<script src="boot.js"></script>');
  fs.writeFileSync(path.join(dist, 'index.html'), html);
  fs.writeFileSync(path.join(dist, 'boot.js'), 'window.__ERPReady.then(function () { boot(); });\n');
  fs.writeFileSync(path.join(dist, '.nojekyll'), '');
  // service worker: stamp the version with a hash of everything published, so phones pick up each new build once
  const h = require('node:crypto').createHash('sha256'), walk = d => { for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f !== 'sw.js') h.update(f).update(fs.readFileSync(p)); } };
  walk(dist); const swFile = path.join(dist, 'sw.js');
  fs.writeFileSync(swFile, fs.readFileSync(swFile, 'utf8').replace('__VERSION__', h.digest('hex').slice(0, 12)).replace("'mobile.js', 'boot.js',", "'mobile.js', 'boot.js', 'standalone-runtime.js', 'standalone-cloud.js', 'standalone-ui.js', 'erp-server.js', 'sql-wasm.js', 'sql-wasm.wasm',"));
  const size = fs.statSync(path.join(dist, 'erp-server.js')).size;
  console.log(`standalone build ok → dist/ (server bundle ${(size / 1024).toFixed(0)} KB)`);
})();
