/**
 * Convert a HuggingFace model to ONNX Runtime GenAI format using builder.py.
 *
 * Usage:
 *   node scripts/convert-model.js -m Qwen/Qwen3-1.7B
 *   node scripts/convert-model.js -m Qwen/Qwen3-1.7B -p int4 -e webgpu
 *   node scripts/convert-model.js -m microsoft/Phi-4-mini-instruct -o Phi-4-mini
 *   node scripts/convert-model.js -m Qwen/Qwen3-1.7B --extra shared_embeddings=true int4_algo_config=rtn_last
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

const GENAI_PATH = config.paths['onnxruntime-genai'];
const MODEL_ROOT = config.paths.models;
const BUILDER_PY = path.join(GENAI_PATH, 'src', 'python', 'py', 'models', 'builder.py');

const DEFAULT_PRECISION = 'int4';
const DEFAULT_EP = 'webgpu';
const DEFAULT_EXTRA_OPTIONS = [
  'shared_embeddings=true',
  'int4_algo_config=rtn_last',
  'int4_is_symmetric=true',
  'enable_webgpu_graph=true',
  'prune_lm_head=true',
];

// ============================================================
// Parse CLI arguments
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    model: null,               // HuggingFace model id, e.g. Qwen/Qwen3-1.7B
    precision: DEFAULT_PRECISION,
    ep: DEFAULT_EP,
    outputName: null,          // Output directory name (default: derived from model id)
    extraOptions: [...DEFAULT_EXTRA_OPTIONS],
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--model':
      case '-m':
        opts.model = args[++i];
        break;
      case '--precision':
      case '-p':
        opts.precision = args[++i];
        break;
      case '--ep':
      case '-e':
        opts.ep = args[++i];
        break;
      case '--output':
      case '-o':
        opts.outputName = args[++i];
        break;
      case '--extra':
      case '--extra_options':
        // Collect all following args until next flag
        opts.extraOptions = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          opts.extraOptions.push(args[++i]);
        }
        break;
      case '--no-extra':
        opts.extraOptions = [];
        break;
      case '--dry-run':
        opts.dryRun = true;
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

  if (!opts.model) {
    console.error('Error: --model is required.');
    printHelp();
    process.exit(1);
  }

  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/convert-model.js [options]

Options:
  -m, --model <id>           HuggingFace model id (required), e.g. Qwen/Qwen3-1.7B
  -p, --precision <type>     Precision: int4, fp16, fp32 (default: ${DEFAULT_PRECISION})
  -e, --ep <provider>        Execution provider: webgpu, cuda, cpu (default: ${DEFAULT_EP})
  -o, --output <name>        Output directory name under models root (default: derived from model id)
      --extra <key=val ...>  Override extra_options (default: ${DEFAULT_EXTRA_OPTIONS.join(' ')})
      --no-extra             Clear all extra_options
      --dry-run              Print the command without running it
  -h, --help                 Show this help
`);
}

// ============================================================
// Main
// ============================================================

function main() {
  const opts = parseArgs();

  if (!fs.existsSync(BUILDER_PY)) {
    console.error(`builder.py not found at: ${BUILDER_PY}`);
    console.error(`Make sure onnxruntime-genai is cloned at: ${GENAI_PATH}`);
    process.exit(1);
  }

  // Derive output name from model id if not specified
  // e.g. "Qwen/Qwen3-1.7B" -> "Qwen3-1.7B"
  const outputName = opts.outputName || opts.model.split('/').pop();
  const outputDir = path.join(MODEL_ROOT, outputName);

  // Build python command
  const pyArgs = [
    BUILDER_PY,
    '-p', opts.precision,
    '-e', opts.ep,
    '-m', opts.model,
  ];

  if (opts.extraOptions.length > 0) {
    pyArgs.push('--extra_options', ...opts.extraOptions);
  }

  pyArgs.push('-o', outputDir);

  console.log(`${'='.repeat(60)}`);
  console.log(`Convert HuggingFace Model to ORT GenAI Format`);
  console.log(`  Model:      ${opts.model}`);
  console.log(`  Precision:  ${opts.precision}`);
  console.log(`  EP:         ${opts.ep}`);
  console.log(`  Output:     ${outputDir}`);
  if (opts.extraOptions.length > 0) {
    console.log(`  Extra opts: ${opts.extraOptions.join(' ')}`);
  }
  console.log(`${'='.repeat(60)}\n`);

  console.log(`Command: python ${pyArgs.join(' ')}\n`);

  if (opts.dryRun) {
    console.log('(dry run — not executing)');
    return;
  }

  const child = spawn('python', pyArgs, {
    cwd: path.dirname(BUILDER_PY),
    stdio: 'inherit',
  });

  child.on('close', (code) => {
    if (code !== 0) {
      console.error(`\nConversion failed with exit code ${code}`);
      process.exit(code);
    }
    console.log(`\nConversion complete! Model saved to: ${outputDir}`);
  });

  child.on('error', (err) => {
    console.error(`Failed to start Python: ${err.message}`);
    process.exit(1);
  });
}

main();
