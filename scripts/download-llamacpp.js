/**
 * Download llama.cpp pre-built releases from GitHub.
 *
 * Downloads CUDA and Vulkan Windows x64 binaries and organizes them
 * into the versioned directory layout: llama.cpp/<version>/{cuda,vulkan}/
 *
 * Usage:
 *   node scripts/download-llamacpp.js                    # Download latest release
 *   node scripts/download-llamacpp.js --version b8200    # Download specific version
 *   node scripts/download-llamacpp.js --list             # List available versions
 *   node scripts/download-llamacpp.js --list-local       # List locally installed versions
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const LLAMA_CPP_ROOT = config.paths['llama.cpp'] || 'E:\\workspace\\project\\test\\llama.cpp';

const GITHUB_API = 'https://api.github.com/repos/ggerganov/llama.cpp/releases';

// Match win x64 binary assets
const CUDA_PATTERN = /llama-b\d+-bin-win-cuda-([\d.]+)-x64\.zip$/;
const VULKAN_PATTERN = /llama-b\d+-bin-win-vulkan-x64\.zip$/;

function getSystemCudaVersion() {
  try {
    const out = execSync('nvcc --version', { encoding: 'utf8', timeout: 5000 });
    const m = out.match(/release ([\d.]+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * Pick the best CUDA asset: highest CUDA version ≤ system CUDA, or just highest.
 */
function pickCudaAsset(assets) {
  const cudaAssets = assets.filter(a => CUDA_PATTERN.test(a.name))
    .map(a => {
      const m = a.name.match(CUDA_PATTERN);
      return { asset: a, cudaVer: m[1], major: parseInt(m[1]) };
    })
    .sort((a, b) => b.major - a.major || b.cudaVer.localeCompare(a.cudaVer));

  if (cudaAssets.length === 0) return null;

  const sysCuda = getSystemCudaVersion();
  if (sysCuda) {
    const sysMajor = parseInt(sysCuda);
    // Pick highest that matches system major version, or just highest overall
    const match = cudaAssets.find(c => c.major <= sysMajor);
    if (match) return match.asset;
  }
  return cudaAssets[0].asset;  // fallback: highest available
}

// ============================================================
// Helpers
// ============================================================

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const options = { headers: { 'User-Agent': 'ort-test-downloader' } };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function httpGetJson(url) {
  const data = await httpGet(url);
  return JSON.parse(data.toString());
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const options = { headers: { 'User-Agent': 'ort-test-downloader' } };
    const file = fs.createWriteStream(dest);
    const request = (u) => {
      https.get(u, options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const totalBytes = parseInt(res.headers['content-length'] || '0');
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (totalBytes > 0) {
            const pct = ((downloaded / totalBytes) * 100).toFixed(0);
            process.stdout.write(`\r  Downloading... ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log(`\r  Downloaded ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
          resolve();
        });
      }).on('error', (err) => {
        file.close();
        fs.unlinkSync(dest);
        reject(err);
      });
    };
    request(url);
  });
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // Use PowerShell's Expand-Archive
  execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, {
    stdio: 'inherit',
    timeout: 120000,
  });
}

// ============================================================
// Commands
// ============================================================

async function listRemoteReleases(count = 10) {
  console.log(`Fetching latest ${count} releases from GitHub...\n`);
  const releases = await httpGetJson(`${GITHUB_API}?per_page=${count}`);

  for (const rel of releases) {
    const tag = rel.tag_name;
    const date = rel.published_at?.slice(0, 10) || 'unknown';
    const cudaAsset = pickCudaAsset(rel.assets);
    const vulkanAsset = rel.assets.find(a => VULKAN_PATTERN.test(a.name));
    const markers = [
      cudaAsset ? 'cuda' : null,
      vulkanAsset ? 'vulkan' : null,
    ].filter(Boolean).join(', ');
    console.log(`  ${tag.padEnd(10)} ${date}  [${markers || 'no win x64 binaries'}]`);
  }
}

function listLocalVersions() {
  if (!fs.existsSync(LLAMA_CPP_ROOT)) {
    console.log(`No llama.cpp directory at ${LLAMA_CPP_ROOT}`);
    return;
  }

  const dirs = fs.readdirSync(LLAMA_CPP_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^b\d+$/.test(d.name))
    .sort((a, b) => parseInt(b.name.slice(1)) - parseInt(a.name.slice(1)));

  if (dirs.length === 0) {
    console.log('No versions installed.');
    return;
  }

  console.log(`Installed versions in ${LLAMA_CPP_ROOT}:\n`);
  for (const d of dirs) {
    const backends = fs.readdirSync(path.join(LLAMA_CPP_ROOT, d.name), { withFileTypes: true })
      .filter(dd => dd.isDirectory())
      .map(dd => dd.name);
    console.log(`  ${d.name.padEnd(10)} [${backends.join(', ')}]`);
  }
  console.log(`\nLatest: ${dirs[0].name}`);
}

async function downloadVersion(version) {
  // Fetch release info
  let release;
  if (version) {
    const tag = version.startsWith('b') ? version : `b${version}`;
    console.log(`Fetching release ${tag}...`);
    try {
      release = await httpGetJson(`${GITHUB_API}/tags/${tag}`);
    } catch {
      console.error(`Release ${tag} not found.`);
      process.exit(1);
    }
  } else {
    console.log('Fetching latest release...');
    // Use releases list instead of /latest to include pre-releases
    const releases = await httpGetJson(`${GITHUB_API}?per_page=1`);
    if (releases.length === 0) {
      console.error('No releases found.');
      process.exit(1);
    }
    release = releases[0];
  }

  const tag = release.tag_name;
  const date = release.published_at?.slice(0, 10) || 'unknown';
  console.log(`Release: ${tag} (${date})\n`);

  const versionDir = path.join(LLAMA_CPP_ROOT, tag);

  // Find assets
  const assets = {};
  const cudaAsset = pickCudaAsset(release.assets);
  if (cudaAsset) assets.cuda = cudaAsset;
  const vulkanAsset = release.assets.find(a => VULKAN_PATTERN.test(a.name));
  if (vulkanAsset) assets.vulkan = vulkanAsset;

  if (Object.keys(assets).length === 0) {
    console.error('No matching Windows x64 binary assets found in this release.');
    process.exit(1);
  }

  // Download and extract each backend
  const tmpDir = path.join(LLAMA_CPP_ROOT, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const [backend, asset] of Object.entries(assets)) {
    const destDir = path.join(versionDir, backend);
    if (fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0) {
      console.log(`  ${backend}: already exists at ${destDir}, skipping.`);
      continue;
    }

    console.log(`  ${backend}: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
    const zipPath = path.join(tmpDir, asset.name);

    await downloadFile(asset.browser_download_url, zipPath);

    console.log('  Extracting...');
    const extractDir = path.join(tmpDir, `${tag}-${backend}`);
    extractZip(zipPath, extractDir);

    // The zip may contain files directly or in a subfolder — normalize
    const extracted = fs.readdirSync(extractDir);
    let sourceDir = extractDir;
    if (extracted.length === 1 && fs.statSync(path.join(extractDir, extracted[0])).isDirectory()) {
      sourceDir = path.join(extractDir, extracted[0]);
    }

    // Move to final location
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of fs.readdirSync(sourceDir)) {
      fs.renameSync(path.join(sourceDir, file), path.join(destDir, file));
    }

    // Cleanup
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.unlinkSync(zipPath);

    console.log(`  Installed to ${destDir}`);
  }

  // Cleanup tmp
  try { fs.rmdirSync(tmpDir); } catch {}

  console.log(`\nDone! ${tag} installed at ${versionDir}`);
  listLocalVersions();
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list') || args.includes('-l')) {
    await listRemoteReleases();
    return;
  }

  if (args.includes('--list-local') || args.includes('-L')) {
    listLocalVersions();
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node scripts/download-llamacpp.js [options]

Options:
  --version <ver>, -V <ver>  Download specific version (e.g. b8200). Default: latest
  --list, -l                 List available releases on GitHub
  --list-local, -L           List locally installed versions
  -h, --help                 Show this help
`);
    return;
  }

  const vIdx = args.findIndex(a => a === '--version' || a === '-V');
  const version = vIdx >= 0 ? args[vIdx + 1] : null;

  await downloadVersion(version);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
