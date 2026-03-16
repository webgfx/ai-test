/**
 * Download ONNX models from HuggingFace for web testing.
 *
 * Usage:
 *   node scripts/download-models.js mobilenetv2-12
 *   node scripts/download-models.js mobilenetv2-12 bert-base-uncased
 *   node scripts/download-models.js --list                    # List available models
 */

const path = require('path');
const fs = require('fs');
const https = require('https');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const AI_MODEL_ROOT = config.paths['ai-models'] || 'E:\\workspace\\project\\test\\ai-models';

const HF_BASE = 'https://huggingface.co/webai-community/ort-models-old/resolve/main';

// HuggingFace token from env or config
const HF_TOKEN = process.env.HF_TOKEN || config.hfToken || '';

// Model folder mapping (from models.js getModelFolderInfo)
const MODEL_FOLDERS = {
  // Models that live in subfolders
};

function getModelUrl(modelName) {
  const folder = MODEL_FOLDERS[modelName] || '';
  return `${HF_BASE}/${folder}${modelName}.onnx`;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'ort-test-downloader' };
    if (HF_TOKEN) {
      headers['Authorization'] = `Bearer ${HF_TOKEN}`;
    }
    const file = fs.createWriteStream(dest);

    const request = (u) => {
      https.get(u, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(dest); } catch {}
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const totalBytes = parseInt(res.headers['content-length'] || '0');
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (totalBytes > 0) {
            const pct = ((downloaded / totalBytes) * 100).toFixed(0);
            const mb = (downloaded / 1024 / 1024).toFixed(1);
            process.stdout.write(`\r  Downloading... ${pct}% (${mb} MB)`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          const mb = (downloaded / 1024 / 1024).toFixed(1);
          console.log(`\r  Downloaded ${mb} MB                    `);
          resolve();
        });
      }).on('error', (err) => {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    };
    request(url);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
Usage: node scripts/download-models.js <model1> [model2] [...]

Downloads ONNX models from HuggingFace to: ${AI_MODEL_ROOT}
Source: ${HF_BASE}

Set HF_TOKEN env variable for private repos:
  $env:HF_TOKEN = "hf_xxx"; node scripts/download-models.js mobilenetv2-12

Examples:
  node scripts/download-models.js mobilenetv2-12
  node scripts/download-models.js mobilenetv2-12 bert-base-uncased albert-base-v2
`);
    return;
  }

  fs.mkdirSync(AI_MODEL_ROOT, { recursive: true });

  for (const modelName of args) {
    if (modelName.startsWith('-')) continue;

    const destFile = path.join(AI_MODEL_ROOT, `${modelName}.onnx`);

    if (fs.existsSync(destFile)) {
      const size = (fs.statSync(destFile).size / 1024 / 1024).toFixed(1);
      console.log(`${modelName}: already exists (${size} MB), skipping.`);
      continue;
    }

    const url = getModelUrl(modelName);
    console.log(`${modelName}: ${url}`);

    try {
      await downloadFile(url, destFile);
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
    }
  }

  console.log(`\nModels saved to: ${AI_MODEL_ROOT}`);
}

main();
