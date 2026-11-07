import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const outPath = path.join(rootDir, 'app.js');

const MODULE_ORDER = [
  'types.ts',
  '01-core-dashboard.ts',
  '02-settings-and-views.ts',
  '03-widget-editor.ts',
  '04-probes-manager.ts',
  '05-alert-router.ts',
  '06-history-analytics.ts',
  '07-hosts-manager.ts',
  '08-plugins-ui.ts',
  '09-flow-canvas.ts',
];

async function buildOnce() {
  const startTime = Date.now();
  const chunks = [
    '// ============================================================================',
    '// AUTO-GENERATED FROM src/*.ts BY scripts/build-ts.mjs — DO NOT EDIT DIRECTLY',
    '// Run `npm run build` to recompile TypeScript sources into app.js',
    '// ============================================================================\n',
  ];

  for (const filename of MODULE_ORDER) {
    const filePath = path.join(srcDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing TypeScript source module: ${filePath}`);
    }
    const tsSource = fs.readFileSync(filePath, 'utf8');
    const result = await esbuild.transform(tsSource, {
      loader: 'ts',
      target: 'es2020',
      sourcemap: false,
      legalComments: 'inline',
      sourcefile: `src/${filename}`,
    });
    if (result.code.trim().length > 0) {
      chunks.push(`// --- [Module: src/${filename}] ---`);
      chunks.push(result.code.trimEnd());
      chunks.push('');
    }
  }

  const finalJs = chunks.join('\n').replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(outPath, finalJs, 'utf8');
  const elapsed = Date.now() - startTime;
  console.log(`[build-ts] Compiled ${MODULE_ORDER.length} TypeScript modules -> app.js (${(finalJs.length / 1024).toFixed(1)} KB) in ${elapsed}ms`);
}

await buildOnce();

if (process.argv.includes('--watch')) {
  console.log('[build-ts] Watching src/*.ts for changes...');
  let timer = null;
  fs.watch(srcDir, { persistent: true }, (_event, filename) => {
    if (!filename || !filename.endsWith('.ts')) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      buildOnce().catch(err => console.error('[build-ts] Build error:', err));
    }, 100);
  });
}
