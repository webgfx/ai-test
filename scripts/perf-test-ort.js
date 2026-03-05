/**
 * Run model perf test.
 * - For WebGPU (default): uses model_benchmark.exe (native C++ build)
 * - For CUDA/CPU: uses Python onnxruntime-genai package (pip install onnxruntime-genai-cuda)
 *
 * Usage:
 *   node scripts/perf-test.js                                    # WebGPU (default)
 *   node scripts/perf-test.js --ep cuda                          # CUDA via Python
 *   node scripts/perf-test.js --ep cpu                           # CPU via Python
 *   node scripts/perf-test.js --model Phi-4-mini-instruct-Edge
 *   node scripts/perf-test.js --prompt "Tell me a story"
 *   node scripts/perf-test.js --iterations 10 --warmup 3
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getSystemInfo } = require('./common');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

const ORT_PATH = config.paths.onnxruntime;
const GENAI_PATH = config.paths['onnxruntime-genai'];
const BUILD_CONFIG = config.build.config;
const OS_DIR = process.platform === 'win32' ? 'Windows' : 'Linux';
const BIN_DIR = path.resolve(path.join(__dirname, '..', config.paths.bin));
const MODEL_ROOT = config.paths.models;
const BENCHMARK_EXE = path.join(BIN_DIR, 'model_benchmark.exe');

// ORT install directory: <onnxruntime>/install/<config>
const ORT_INSTALL_DIR = path.join(ORT_PATH, 'install', BUILD_CONFIG);

// ============================================================
// Copy binaries from build outputs to gitignore/bin
// ============================================================

function copyBinaries() {
  const sources = {
    // From ORT install
    'onnxruntime.dll': path.join(ORT_INSTALL_DIR, 'bin', 'onnxruntime.dll'),

    // Dawn DLLs from ORT build (not included in cmake install)
    'dxcompiler.dll': path.join(ORT_PATH, 'build', OS_DIR, BUILD_CONFIG, BUILD_CONFIG, 'dxcompiler.dll'),
    'dxil.dll': path.join(ORT_PATH, 'build', OS_DIR, BUILD_CONFIG, BUILD_CONFIG, 'dxil.dll'),

    // From GenAI build
    'model_benchmark.exe': path.join(GENAI_PATH, 'build', OS_DIR, BUILD_CONFIG, 'benchmark', 'c', BUILD_CONFIG, 'model_benchmark.exe'),
    'onnxruntime-genai.dll': path.join(GENAI_PATH, 'build', OS_DIR, BUILD_CONFIG, BUILD_CONFIG, 'onnxruntime-genai.dll'),
  };

  fs.mkdirSync(BIN_DIR, { recursive: true });
  console.log(`Copying binaries to: ${BIN_DIR}\n`);

  let success = 0;
  let failed = 0;

  for (const [name, src] of Object.entries(sources)) {
    const dest = path.join(BIN_DIR, name);
    if (fs.existsSync(src)) {
      // Only copy if source is newer than destination
      if (!fs.existsSync(dest) || fs.statSync(src).mtimeMs > fs.statSync(dest).mtimeMs) {
        fs.copyFileSync(src, dest);
        const size = (fs.statSync(dest).size / 1024).toFixed(0);
        console.log(`  [COPIED] ${name} (${size} KB)`);
      } else {
        console.log(`  [UP-TO-DATE] ${name}`);
      }
      success++;
    } else {
      console.error(`  [MISSING] ${name} - expected at: ${src}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} ready, ${failed} missing.`);
  if (failed > 0) {
    console.error('Some binaries are missing. Run "node scripts/build-ort.js all" first.');
    process.exit(1);
  }
}

// ============================================================
// Parse CLI arguments
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    model: Object.keys(config.models)[0],
    promptLength: config.perf.promptTokens,
    genLength: config.perf.genTokens,
    prompt: null,
    iterations: config.perf.iterations,
    warmup: config.perf.warmup,
    verbose: false,
    maxLength: 0,
    ep: null,  // execution provider: cuda, cpu (default: WebGPU via native build)
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--model':
      case '-m':
        opts.model = args[++i];
        break;
      case '--prompt-length':
      case '-pl':
        opts.promptLength = parseInt(args[++i]);
        break;
      case '--gen-length':
      case '-gl':
        opts.genLength = parseInt(args[++i]);
        break;
      case '--prompt':
        opts.prompt = args[++i];
        break;
      case '--iterations':
      case '-r':
        opts.iterations = parseInt(args[++i]);
        break;
      case '--warmup':
      case '-w':
        opts.warmup = parseInt(args[++i]);
        break;
      case '--max-length':
      case '-ml':
        opts.maxLength = parseInt(args[++i]);
        break;
      case '--ep':
      case '-e':
        opts.ep = args[++i];
        break;
      case '--verbose':
      case '-v':
        opts.verbose = true;
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
Usage: node scripts/perf-test.js [options]

Options:
  -m, --model <name>          Model name (default: ${Object.keys(config.models)[0]})
  -e, --ep <provider>         Execution provider: cuda, cpu (default: WebGPU via native build)
  -pl, --prompt-length <n>    Number of prompt tokens (default: ${config.perf.promptTokens})
  -gl, --gen-length <n>       Number of tokens to generate (default: ${config.perf.genTokens})
      --prompt <text>         Use specific prompt text instead of generated prompt
  -r, --iterations <n>        Number of benchmark iterations (default: ${config.perf.iterations})
  -w, --warmup <n>            Number of warmup iterations (default: ${config.perf.warmup})
  -ml, --max-length <n>       Max sequence length (0 = auto)
  -v, --verbose               Verbose output
  -h, --help                  Show this help

Available models:
${Object.keys(config.models).map(m => `  - ${m}`).join('\n')}
`);
}

// ============================================================
// Main
// ============================================================

function main() {
  const opts = parseArgs();

  // Validate model
  const modelInfo = config.models[opts.model];
  if (!modelInfo) {
    console.error(`Unknown model: ${opts.model}`);
    console.error(`Available models: ${Object.keys(config.models).join(', ')}`);
    process.exit(1);
  }

  const modelPath = path.join(MODEL_ROOT, modelInfo.path);
  if (!fs.existsSync(modelPath)) {
    console.error(`Model directory not found: ${modelPath}`);
    process.exit(1);
  }

  // Dispatch: CUDA/CPU use Python genai package, WebGPU/default use native model_benchmark.exe
  if (opts.ep === 'cuda' || opts.ep === 'cpu') {
    runPython(opts, modelPath);
  } else {
    runNative(opts, modelPath);
  }
}

/**
 * Run via native model_benchmark.exe (WebGPU / default EP)
 */
function runNative(opts, modelPath) {
  // Copy binaries (skips if up-to-date)
  copyBinaries();

  const args = [
    '-i', modelPath,
    '-g', opts.genLength.toString(),
    '-r', opts.iterations.toString(),
    '-w', opts.warmup.toString(),
  ];

  if (opts.prompt) {
    args.push('--prompt', opts.prompt);
  } else {
    args.push('-l', opts.promptLength.toString());
  }

  if (opts.maxLength > 0) {
    args.push('-ml', opts.maxLength.toString());
  }

  if (opts.ep) {
    args.push('-e', opts.ep);
  }

  if (opts.verbose) {
    args.push('-v');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Model:       ${opts.model}`);
  console.log(`EP:          ${opts.ep || '(default/WebGPU)'}`);
  console.log(`Runner:      model_benchmark.exe (native)`);
  console.log(`Model path:  ${modelPath}`);
  console.log(`Prompt:      ${opts.prompt || `${opts.promptLength} tokens (generated)`}`);
  console.log(`Gen tokens:  ${opts.genLength}`);
  console.log(`Iterations:  ${opts.iterations} (warmup: ${opts.warmup})`);
  console.log(`${'='.repeat(60)}\n`);

  const child = spawn(BENCHMARK_EXE, args, {
    cwd: BIN_DIR,
    stdio: 'inherit',
    env: { ...process.env, PATH: `${BIN_DIR};${process.env.PATH}` },
  });

  child.on('close', (code) => {
    if (code !== 0) {
      console.error(`\nmodel_benchmark exited with code ${code}`);
      process.exit(code);
    }
    console.log('\nBenchmark completed.');
  });

  child.on('error', (err) => {
    console.error(`Failed to start model_benchmark: ${err.message}`);
    process.exit(1);
  });
}

/**
 * Run via Python onnxruntime-genai package (CUDA / CPU EP)
 * Requires: pip install onnxruntime-genai-cuda onnxruntime-gpu
 */
function runPython(opts, modelPath) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Model:       ${opts.model}`);
  console.log(`EP:          ${opts.ep}`);
  console.log(`Runner:      Python onnxruntime-genai`);
  console.log(`Model path:  ${modelPath}`);
  console.log(`Prompt:      ${opts.prompt || `${opts.promptLength} tokens`}`);
  console.log(`Gen tokens:  ${opts.genLength}`);
  console.log(`Iterations:  ${opts.iterations} (warmup: ${opts.warmup})`);
  console.log(`${'='.repeat(60)}\n`);

  const pyArgs = [
    path.join(__dirname, 'perf-test-genai.py'),
    '-m', opts.model,
    '-e', opts.ep,
    '-g', opts.genLength.toString(),
    '-r', opts.iterations.toString(),
    '-w', opts.warmup.toString(),
    '-l', opts.promptLength.toString(),
  ];

  if (opts.prompt) {
    pyArgs.push('--prompt', opts.prompt);
  }
  if (opts.verbose) {
    pyArgs.push('-v');
  }

  const child = spawn('python', pyArgs, {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });

  child.on('close', (code) => {
    if (code !== 0) {
      console.error(`\nPython perf test exited with code ${code}`);
      process.exit(code);
    }
  });

  child.on('error', (err) => {
    console.error(`Failed to start Python: ${err.message}`);
    process.exit(1);
  });
}

main();
