/**
 * Run ORT WebGPU performance test in the browser using Puppeteer.
 *
 * Usage:
 *   node scripts/perf-test-ort-web.js -m mobilenetv2-12
 *   node scripts/perf-test-ort-web.js -m bert-base-uncased --ep webgpu
 *   node scripts/perf-test-ort-web.js -m mobilenetv2-12 --ort-url /path/to/onnxruntime/js/web/dist
 *   node scripts/perf-test-ort-web.js -m mobilenetv2-12 -r 10 -w 5
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { getSystemInfo } = require('./common');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

const ORT_PATH = config.paths.onnxruntime;
const AI_MODEL_ROOT = config.paths['ai-models'] || path.join(path.dirname(ORT_PATH), 'ai-models');
const ORT_MODEL_ROOT = config.paths['ort-models'] || path.join(path.dirname(ORT_PATH), '..', 'ort-models');
const RESULTS_DIR = config.paths.results || path.resolve(path.join(__dirname, '..', 'gitignore', 'results'));
const WEB_DIR = path.resolve(path.join(__dirname, '..', 'web'));

// ============================================================
// Simple HTTP server to serve web/ directory
// ============================================================

function startServer(port = 8899) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let filePath = path.join(WEB_DIR, urlPath === '/' ? 'index.html' : urlPath);

      // Serve ORT JS files from the ORT source tree
      if (req.url.startsWith('/ort-dist/')) {
        filePath = path.join(ORT_PATH, 'js', 'web', 'dist', decodeURIComponent(req.url.replace('/ort-dist/', '')));
      }

      // Serve local model files
      if (req.url.startsWith('/models/')) {
        const modelFile = decodeURIComponent(req.url.replace('/models/', ''));
        // Search in ort-models first, then ai-models
        const candidates = [
          path.join(ORT_MODEL_ROOT, modelFile),
          path.join(AI_MODEL_ROOT, modelFile),
        ];
        filePath = candidates.find(p => fs.existsSync(p)) || candidates[0];
      }

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const ext = path.extname(filePath);
      const mimeTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.wasm': 'application/wasm',
      };

      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(port, () => {
      console.log(`[Server] Serving web/ at http://localhost:${port}`);
      resolve(server);
    });
  });
}

// ============================================================
// Parse CLI arguments
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    models: ['mobilenetv2-12'],
    ep: 'webgpu',
    runTimes: 5,
    warmupTimes: 5,
    ortUrl: 'default',
    ortVersion: 'dev',
    modelUrl: 'server',
    port: 8899,
    headless: true,
    enableGraphCapture: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--model':
      case '-m': {
        const val = args[++i];
        opts.models = val.split(',').map(s => s.trim()).filter(Boolean);
        break;
      }
      case '--ep':
      case '-e':
        opts.ep = args[++i];
        break;
      case '--run-times':
      case '-r':
        opts.runTimes = parseInt(args[++i]);
        break;
      case '--warmup-times':
      case '-w':
        opts.warmupTimes = parseInt(args[++i]);
        break;
      case '--ort-url':
        opts.ortUrl = args[++i];
        break;
      case '--ort-version':
        opts.ortVersion = args[++i];
        break;
      case '--model-url':
        opts.modelUrl = args[++i];
        break;
      case '--port':
        opts.port = parseInt(args[++i]);
        break;
      case '--no-headless':
        opts.headless = false;
        break;
      case '--gc':
        opts.enableGraphCapture = true;
        break;
      case '--no-gc':
        opts.enableGraphCapture = false;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown option: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/perf-test-ort-web.js [options]

Options:
  -m, --model <name>          Model name(s) from models.js (default: mobilenetv2-12)
  -e, --ep <provider>         Execution provider: webgpu, wasm (default: webgpu)
  -r, --run-times <n>         Number of inference runs (default: 5)
  -w, --warmup-times <n>      Number of warmup runs (default: 5)
  --ort-url <url|path>        ORT JS URL or local path (default: CDN)
  --ort-version <ver>         ORT version for CDN (default: dev)
  --model-url <url>           Model URL source: hf, server (default: hf)
  --port <n>                  Local server port (default: 8899)
  --no-headless               Run browser visually
  --gc                        Enable graph capture
  --no-gc                     Disable graph capture
  -h, --help                  Show this help
`);
}

// ============================================================
// Run a benchmark via Puppeteer
// ============================================================

async function runWebBenchmark(opts, modelName, port) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    console.error('Puppeteer is not installed. Run: npm install puppeteer');
    process.exit(1);
  }

  // Build URL with parameters
  const params = new URLSearchParams({
    modelName,
    ep: opts.ep,
    task: 'performance',
    runTimes: opts.runTimes.toString(),
    warmupTimes: opts.warmupTimes.toString(),
    modelUrl: opts.modelUrl,
    ortVersion: opts.ortVersion,
  });

  if (opts.ortUrl !== 'default') {
    // If it's a local path, serve via our server
    if (fs.existsSync(opts.ortUrl)) {
      params.set('ortUrl', `http://localhost:${port}/ort-dist`);
    } else {
      params.set('ortUrl', opts.ortUrl);
    }
  }

  if (opts.enableGraphCapture != null) {
    params.set('enableGraphCapture', opts.enableGraphCapture ? 'true' : 'false');
  }

  const url = `http://localhost:${port}/?${params.toString()}`;
  console.log(`  URL: ${url}`);

  const browser = await puppeteer.launch({
    args: [
      '--enable-features=SharedArrayBuffer',
      '--enable-webgpu-developer-features',
      '--enable-dawn-features=allow_unsafe_apis',
      '--disable-dawn-features=disallow_unsafe_apis',
      '--no-sandbox',
    ],
    headless: opts.headless ? 'new' : false,
    defaultViewport: null,
  });

  const page = await browser.newPage();

  // Collect console output and errors
  const consoleOutput = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleOutput.push(text);
  });
  page.on('pageerror', err => {
    consoleOutput.push(`[PAGE ERROR] ${err.message}`);
  });
  page.on('requestfailed', req => {
    consoleOutput.push(`[REQUEST FAILED] ${req.url()} ${req.failure()?.errorText}`);
  });
  page.on('response', res => {
    if (res.status() >= 400) {
      consoleOutput.push(`[HTTP ${res.status()}] ${res.url()}`);
    }
  });

  let result = null;
  const timeout = 300000; // 5 minutes

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for the result element to appear with data
    await page.waitForSelector('#result', { timeout });
    await page.waitForFunction(
      () => {
        const el = document.getElementById('result');
        return el && el.innerText && el.innerText.startsWith('{');
      },
      { timeout }
    );

    const resultText = await page.$eval('#result', el => el.innerText);
    result = JSON.parse(resultText);
  } catch (err) {
    // Log console output for debugging
    if (consoleOutput.length > 0) {
      console.log('\n  Browser console:');
      for (const line of consoleOutput.slice(-20)) {
        console.log(`    ${line}`);
      }
    }
    result = { error: err.message };
  }

  await browser.close();
  return result;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const opts = parseArgs();
  const sysInfo = getSystemInfo();

  // Start local server
  const server = await startServer(opts.port);

  // Use local ORT build if available
  const localOrtDist = path.join(ORT_PATH, 'js', 'web', 'dist');
  if (opts.ortUrl === 'default' && fs.existsSync(path.join(localOrtDist, 'ort.all.min.js'))) {
    opts.ortUrl = localOrtDist;
    console.log(`Using local ORT build: ${localOrtDist}`);
  }

  // Create timestamped result folder
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const resultDir = path.join(RESULTS_DIR, timestamp);
  fs.mkdirSync(resultDir, { recursive: true });

  console.log(`${'='.repeat(60)}`);
  console.log(`ORT Web Benchmark`);
  console.log(`Models:      ${opts.models.join(', ')}`);
  console.log(`EP:          ${opts.ep}`);
  console.log(`Runs:        ${opts.runTimes} (warmup: ${opts.warmupTimes})`);
  console.log(`ORT URL:     ${opts.ortUrl}`);
  console.log(`GPU:         ${sysInfo.gpu}`);
  console.log(`Results:     ${resultDir}`);
  console.log(`${'='.repeat(60)}\n`);

  const allResults = {
    system: sysInfo,
    config: {
      ep: opts.ep,
      runs: opts.runTimes,
      warmup: opts.warmupTimes,
      ortUrl: opts.ortUrl,
      ortVersion: opts.ortVersion,
      modelUrl: opts.modelUrl,
      graphCapture: opts.enableGraphCapture,
    },
    results: [],
  };

  for (const modelName of opts.models) {
    process.stdout.write(`  ${modelName} ... `);

    const result = await runWebBenchmark(opts, modelName, opts.port);

    if (result.error) {
      console.log(`ERROR: ${result.error}`);
      allResults.results.push({ model: modelName, ep: opts.ep, error: result.error });
    } else {
      const record = {
        model: modelName,
        ep: opts.ep,
        firstMs: result.first,
        averageMs: result.average,
        bestMs: result.best,
      };
      allResults.results.push(record);

      const parts = [];
      if (result.first != null) parts.push(`First: ${result.first} ms`);
      if (result.average != null) parts.push(`Avg: ${result.average} ms`);
      if (result.best != null) parts.push(`Best: ${result.best} ms`);
      console.log(parts.join('  |  '));
    }
  }

  // Write results
  const resultFile = path.join(resultDir, 'ort-web-results.json');
  fs.writeFileSync(resultFile, JSON.stringify(allResults, null, 2));

  // Write text summary
  const summaryLines = [
    `ORT Web Benchmark Results`,
    `${'='.repeat(60)}`,
    ``,
    `System Information`,
    `  CPU:        ${sysInfo.cpu}`,
    `  GPU:        ${sysInfo.gpu}`,
    `  GPU Driver: ${sysInfo.gpuDriver}`,
    `  OS:         ${sysInfo.os}`,
    `  Timestamp:  ${sysInfo.timestamp}`,
    ``,
    `Test Configuration`,
    `  EP:         ${opts.ep}`,
    `  Runs:       ${opts.runTimes}`,
    `  Warmup:     ${opts.warmupTimes}`,
    `  ORT URL:    ${opts.ortUrl}`,
    ``,
    `Results`,
    `${'='.repeat(70)}`,
    `${'Model'.padEnd(30)} ${'First (ms)'.padEnd(12)} ${'Avg (ms)'.padEnd(12)} ${'Best (ms)'.padEnd(12)}`,
    `${'-'.repeat(70)}`,
  ];

  for (const r of allResults.results) {
    if (r.error) {
      summaryLines.push(`${(r.model || '').padEnd(30)} ERROR: ${r.error}`);
    } else {
      summaryLines.push(
        `${(r.model || '').padEnd(30)} ${String(r.firstMs ?? '').padEnd(12)} ${String(r.averageMs ?? '').padEnd(12)} ${String(r.bestMs ?? '').padEnd(12)}`
      );
    }
  }

  const summaryFile = path.join(resultDir, 'ort-web-results.txt');
  fs.writeFileSync(summaryFile, summaryLines.join('\n'));

  console.log(`\nResults saved to:`);
  console.log(`  JSON: ${resultFile}`);
  console.log(`  Text: ${summaryFile}`);

  server.close();
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
