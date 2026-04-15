/**
 * Baseline management for AI benchmark results.
 *
 * Store, compare, and track performance baselines per (hostname, model, runtime, backend).
 * Baselines follow the backpack pattern: one JSON file per configuration.
 *
 * Usage:
 *   node scripts/baseline.js save <run-dir>                Save a run as baseline
 *   node scripts/baseline.js save --stdin                   Save from stdin JSON (ai-test.py format)
 *   node scripts/baseline.js compare <run-dir>              Compare run against baselines
 *   node scripts/baseline.js compare --stdin [--auto-save]  Compare from stdin, optionally save new baselines
 *   node scripts/baseline.js list                           List saved baselines
 *   node scripts/baseline.js delete <key>                   Delete a baseline
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadConfig } = require('./common');

const config = loadConfig();
const BASELINES_DIR = config.paths.baselines || path.join(__dirname, '..', 'baselines');

// ============================================================
// Helpers
// ============================================================

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
}

function baselineKey(hostname, model, runtime, backend) {
  return `${safeName(hostname)}_${safeName(model)}_${safeName(runtime)}_${safeName(backend)}`;
}

function baselinePath(key) {
  return path.join(BASELINES_DIR, `${key}.json`);
}

function ensureDir() {
  fs.mkdirSync(BASELINES_DIR, { recursive: true });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

/**
 * Extract series from ai-test.py output format:
 * { results: { files: { "results.json": { system, runtimes: { llamacpp: { results: [...] }, ort: { results: [...] } } } } } }
 */
function extractSeries(data) {
  const series = [];
  const hostname = data?.results?.files?.['results.json']?.system?.hostname || os.hostname();
  const system = data?.results?.files?.['results.json']?.system || {};

  const files = data?.results?.files || {};
  for (const [, fileData] of Object.entries(files)) {
    if (!fileData?.runtimes) continue;
    for (const [runtime, runtimeData] of Object.entries(fileData.runtimes)) {
      const results = runtimeData?.results;
      if (!Array.isArray(results)) continue;

      // Group by (model, backend/ep)
      const grouped = new Map();
      for (const r of results) {
        const model = r.model || 'unknown';
        const backend = r.backend || r.ep || 'default';
        const key = `${model}|${backend}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(r);
      }

      for (const [key, points] of grouped) {
        const [model, backend] = key.split('|');
        series.push({
          hostname,
          system,
          model,
          runtime,
          backend,
          results: points.map(r => ({
            pl: r.pl,
            tg: r.tg,
            ttftMs: r.ttftMs ?? null,
            plTs: r.plTs ?? r.ppTs ?? null,
            tgTs: r.tgTs ?? null,
            e2eMs: r.e2eMs ?? null,
          })),
        });
      }
    }
  }

  return series;
}

/**
 * Extract series from a run directory (timestamped folder with results.json / *-results.json).
 */
function extractSeriesFromDir(dirName) {
  const resultsDir = config.paths.results || path.join(__dirname, '..', 'gitignore', 'results');
  const dir = path.join(resultsDir, dirName);
  if (!fs.existsSync(dir)) {
    console.error(`Result directory not found: ${dir}`);
    process.exit(1);
  }

  const series = [];
  const hostname = os.hostname();

  // Load unified results.json
  const unifiedFile = path.join(dir, 'results.json');
  if (fs.existsSync(unifiedFile)) {
    const data = JSON.parse(fs.readFileSync(unifiedFile, 'utf8'));
    const system = data.system || {};

    if (data.runtimes) {
      for (const [runtime, runtimeData] of Object.entries(data.runtimes)) {
        const results = runtimeData?.results || [];
        const grouped = new Map();
        for (const r of results) {
          const model = r.model || 'unknown';
          const backend = r.backend || r.ep || 'default';
          const key = `${model}|${backend}`;
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key).push(r);
        }
        for (const [key, points] of grouped) {
          const [model, backend] = key.split('|');
          series.push({
            hostname: system.hostname || hostname,
            system,
            model,
            runtime,
            backend,
            results: points.map(r => ({
              pl: r.pl, tg: r.tg,
              ttftMs: r.ttftMs ?? null, plTs: r.plTs ?? r.ppTs ?? null,
              tgTs: r.tgTs ?? null, e2eMs: r.e2eMs ?? null,
            })),
          });
        }
      }
    }
  }

  // Load per-runtime files
  const files = fs.readdirSync(dir).filter(f => f.endsWith('-results.json'));
  for (const file of files) {
    const runtime = file.replace('-results.json', '');
    // Skip if already loaded from unified
    if (series.some(s => s.runtime === runtime)) continue;

    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const system = data.system || {};
    const results = data.results || [];
    const grouped = new Map();
    for (const r of results) {
      const model = r.model || 'unknown';
      const backend = r.backend || r.ep || 'default';
      const key = `${model}|${backend}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }
    for (const [key, points] of grouped) {
      const [model, backend] = key.split('|');
      series.push({
        hostname: system.hostname || hostname,
        system,
        model,
        runtime,
        backend,
        results: points.map(r => ({
          pl: r.pl, tg: r.tg,
          ttftMs: r.ttftMs ?? null, plTs: r.plTs ?? r.ppTs ?? null,
          tgTs: r.tgTs ?? null, e2eMs: r.e2eMs ?? null,
        })),
      });
    }
  }

  return { series, dirName };
}

// ============================================================
// Commands
// ============================================================

function saveBaseline(seriesItem, sourceDir) {
  ensureDir();
  const key = baselineKey(seriesItem.hostname, seriesItem.model, seriesItem.runtime, seriesItem.backend);
  const baseline = {
    system: seriesItem.system,
    model: seriesItem.model,
    runtime: seriesItem.runtime,
    backend: seriesItem.backend,
    results: seriesItem.results,
    createdAt: new Date().toISOString(),
    sourceDir: sourceDir || null,
  };
  fs.writeFileSync(baselinePath(key), JSON.stringify(baseline, null, 2), 'utf-8');
  return key;
}

function loadBaseline(hostname, model, runtime, backend) {
  const key = baselineKey(hostname, model, runtime, backend);
  const p = baselinePath(key);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function compareSeries(seriesList, autoSave, sourceDir) {
  const comparisons = [];

  for (const s of seriesList) {
    const baseline = loadBaseline(s.hostname, s.model, s.runtime, s.backend);

    if (!baseline) {
      if (autoSave) {
        const key = saveBaseline(s, sourceDir);
        console.error(`[baseline] No baseline found, saved as initial: ${key}`);
        comparisons.push({
          label: `${s.model} / ${s.backend} (${s.runtime})`,
          hostname: s.hostname,
          hasBaseline: false,
          savedAsNew: true,
          points: s.results.map(r => ({
            pl: r.pl,
            current: { ttftMs: r.ttftMs, plTs: r.plTs, tgTs: r.tgTs },
            baseline: null,
            delta: null,
          })),
        });
      } else {
        comparisons.push({
          label: `${s.model} / ${s.backend} (${s.runtime})`,
          hostname: s.hostname,
          hasBaseline: false,
          savedAsNew: false,
          points: s.results.map(r => ({
            pl: r.pl,
            current: { ttftMs: r.ttftMs, plTs: r.plTs, tgTs: r.tgTs },
            baseline: null,
            delta: null,
          })),
        });
      }
      continue;
    }

    // Build baseline lookup by pl
    const baselineMap = new Map();
    for (const bp of baseline.results) {
      baselineMap.set(bp.pl, bp);
    }

    const points = [];
    for (const r of s.results) {
      const bp = baselineMap.get(r.pl);
      if (bp) {
        const pctChange = (curr, base) => {
          if (curr == null || base == null || base === 0) return null;
          return +((curr - base) / base * 100).toFixed(2);
        };
        points.push({
          pl: r.pl,
          current: { ttftMs: r.ttftMs, plTs: r.plTs, tgTs: r.tgTs },
          baseline: { ttftMs: bp.ttftMs, plTs: bp.plTs, tgTs: bp.tgTs },
          delta: {
            ttftMs: pctChange(r.ttftMs, bp.ttftMs),
            plTs: pctChange(r.plTs, bp.plTs),
            tgTs: pctChange(r.tgTs, bp.tgTs),
          },
        });
      } else {
        points.push({
          pl: r.pl,
          current: { ttftMs: r.ttftMs, plTs: r.plTs, tgTs: r.tgTs },
          baseline: null,
          delta: null,
        });
      }
    }

    comparisons.push({
      label: `${s.model} / ${s.backend} (${s.runtime})`,
      hostname: s.hostname,
      hasBaseline: true,
      baselineCreatedAt: baseline.createdAt,
      points,
    });
  }

  return { comparisons };
}

function listBaselines() {
  if (!fs.existsSync(BASELINES_DIR)) {
    console.log('No baselines directory found.');
    return;
  }

  const files = fs.readdirSync(BASELINES_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No baselines saved yet.');
    return;
  }

  console.log(`Baselines in ${BASELINES_DIR}:\n`);
  for (const file of files.sort()) {
    try {
      const b = JSON.parse(fs.readFileSync(path.join(BASELINES_DIR, file), 'utf-8'));
      const pls = (b.results || []).map(r => r.pl).join(', ');
      console.log(`  ${file.replace('.json', '')}`);
      console.log(`    ${b.model} / ${b.backend} (${b.runtime}) — PLs: [${pls}]`);
      console.log(`    Created: ${b.createdAt || '?'}  Source: ${b.sourceDir || '?'}`);
      console.log();
    } catch {
      console.log(`  ${file} (unreadable)`);
    }
  }
}

function deleteBaseline(key) {
  const p = baselinePath(key);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log(`Deleted: ${key}`);
  } else {
    console.error(`Baseline not found: ${key}`);
    process.exit(1);
  }
}

// ============================================================
// CLI
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`
Usage: node scripts/baseline.js <command> [options]

Commands:
  save <run-dir>                 Save a run directory as baselines
  save --stdin                   Save from stdin JSON (ai-test.py output format)
  compare <run-dir>              Compare run against baselines (JSON to stdout)
  compare --stdin [--auto-save]  Compare from stdin, auto-save new baselines
  list                           List saved baselines
  delete <key>                   Delete a baseline by key
`);
    return;
  }

  if (command === 'list') {
    listBaselines();
    return;
  }

  if (command === 'delete') {
    const key = args[1];
    if (!key) { console.error('Please provide a baseline key.'); process.exit(1); }
    deleteBaseline(key);
    return;
  }

  if (command === 'save') {
    let seriesList, sourceDir;

    if (args.includes('--stdin')) {
      const input = await readStdin();
      const data = JSON.parse(input);
      seriesList = extractSeries(data);
      sourceDir = 'stdin';
    } else {
      const dirName = args[1];
      if (!dirName) { console.error('Please provide a run directory name.'); process.exit(1); }
      const extracted = extractSeriesFromDir(dirName);
      seriesList = extracted.series;
      sourceDir = dirName;
    }

    if (seriesList.length === 0) {
      console.error('No benchmark series found in the input.');
      process.exit(1);
    }

    ensureDir();
    for (const s of seriesList) {
      const key = saveBaseline(s, sourceDir);
      console.log(`Saved baseline: ${key}`);
    }
    return;
  }

  if (command === 'compare') {
    const autoSave = args.includes('--auto-save');
    let seriesList, sourceDir;

    if (args.includes('--stdin')) {
      const input = await readStdin();
      const data = JSON.parse(input);
      seriesList = extractSeries(data);
      sourceDir = 'stdin';
    } else {
      const dirName = args[1];
      if (!dirName) { console.error('Please provide a run directory name.'); process.exit(1); }
      const extracted = extractSeriesFromDir(dirName);
      seriesList = extracted.series;
      sourceDir = dirName;
    }

    if (seriesList.length === 0) {
      console.error('No benchmark series found in the input.');
      process.exit(1);
    }

    const result = compareSeries(seriesList, autoSave, sourceDir);

    // Output comparison JSON to stdout
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
