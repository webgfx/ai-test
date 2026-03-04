/**
 * Build script for ONNX Runtime and ONNX Runtime GenAI.
 * Follows https://github.com/webgfx/toolkit/blob/master/misc/ort.py
 *
 * Usage:
 *   node scripts/build-ort.js                          # Build ORT (WebGPU) + GenAI
 *   node scripts/build-ort.js --ep webgpu,web            # Build ORT (WebGPU + Web) + GenAI
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ============================================================
// Configuration
// ============================================================

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

const ORT_PATH = config.paths.onnxruntime;
const GENAI_PATH = config.paths['onnxruntime-genai'];
const BUILD_CONFIG = config.build.config;
const OS_DIR = process.platform === 'win32' ? 'Windows' : 'Linux';
const BUILD_CMD = process.platform === 'win32' ? '.\\build.bat' : './build.sh';

// ORT install directory: <onnxruntime>/install/<config>
const ORT_INSTALL_DIR = path.join(ORT_PATH, 'install');

// ============================================================
// Utilities
// ============================================================

function runCommand(cmd, cwd, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${label}] Running: ${cmd}`);
  console.log(`[${label}] CWD: ${cwd}`);
  console.log('='.repeat(60) + '\n');

  const child = spawn(cmd, { cwd, shell: true, stdio: 'inherit' });

  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`[${label}] Process exited with code ${code}`));
      } else {
        console.log(`\n[${label}] Completed successfully.`);
        resolve();
      }
    });
    child.on('error', (err) => reject(err));
  });
}

function copyDirContents(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ============================================================
// Step 1: Build ONNX Runtime
// ============================================================

async function buildOrt({ eps = ['webgpu'] } = {}) {
  if (!fs.existsSync(ORT_PATH)) {
    throw new Error(`ONNX Runtime source not found at: ${ORT_PATH}`);
  }

  // Build native
  const useWebgpu = eps.includes('webgpu');
  const useWeb = eps.includes('web');

  // Native build (WebGPU)
  if (useWebgpu) {
    const buildArgs = [
      BUILD_CMD,
      `--config ${BUILD_CONFIG}`,
      '--skip_tests',
      '--build_shared_lib',
      '--parallel',
      '--skip_submodule_sync',
      '--use_webgpu',
      '--cmake_extra_defines onnxruntime_BUILD_UNIT_TESTS=OFF',
    ];

    const buildCmd = buildArgs.join(' ');

    try {
      await runCommand(buildCmd, ORT_PATH, 'ORT Native Build');
    } catch (err) {
      console.log('\n[ORT Build] Build failed, retrying without --skip_submodule_sync...\n');
      const retryArgs = buildArgs.filter(a => a !== '--skip_submodule_sync');
      await runCommand(retryArgs.join(' '), ORT_PATH, 'ORT Native Build (retry)');
    }
  }

  // Web build (WASM) - separate build since it uses Emscripten toolchain
  if (useWeb) {
    const webBuildArgs = [
      BUILD_CMD,
      `--config ${BUILD_CONFIG}`,
      '--build_wasm',
      '--enable_wasm_simd',
      '--enable_wasm_threads',
      '--skip_tests',
      '--parallel',
      '--skip_submodule_sync',
      '--use_jsep',
      '--target onnxruntime_webassembly',
    ];

    const webBuildCmd = webBuildArgs.join(' ');

    try {
      await runCommand(webBuildCmd, ORT_PATH, 'ORT Web Build');
    } catch (err) {
      console.log('\n[ORT Web] Build failed, retrying without --skip_submodule_sync...\n');
      const retryArgs = webBuildArgs.filter(a => a !== '--skip_submodule_sync');
      await runCommand(retryArgs.join(' '), ORT_PATH, 'ORT Web Build (retry)');
    }
  }

  // cmake --install into <onnxruntime>/install/<config>
  const buildDir = path.join(ORT_PATH, 'build', OS_DIR);
  const ortHome = path.join(ORT_INSTALL_DIR, BUILD_CONFIG);
  fs.mkdirSync(ortHome, { recursive: true });

  const installCmd = `cmake --install ${BUILD_CONFIG} --config ${BUILD_CONFIG} --prefix "${ortHome}"`;
  await runCommand(installCmd, buildDir, 'ORT Install');

  // Post-install fixup: bin/* -> lib/, include/onnxruntime/* -> include/
  const binDir = path.join(ortHome, 'bin');
  const libDir = path.join(ortHome, 'lib');
  if (fs.existsSync(binDir)) {
    copyDirContents(binDir, libDir);
  }
  const ortInclude = path.join(ortHome, 'include', 'onnxruntime');
  const includeDir = path.join(ortHome, 'include');
  if (fs.existsSync(ortInclude)) {
    copyDirContents(ortInclude, includeDir);
  }

  console.log(`[ORT] Installed to: ${ortHome}`);
}

// ============================================================
// Step 2: Install VS Spectre-mitigated libraries
// ============================================================

const VSWHERE = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
const VS_INSTALLER = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vs_installer.exe';
const REQUIRED_VS_COMPONENTS = [
  'Microsoft.VisualStudio.Component.VC.Spectre.x86.x64',
];

function getVsInstallInfo() {
  try {
    const installPath = execSync(`"${VSWHERE}" -latest -property installationPath`, { encoding: 'utf8' }).trim();
    const version = execSync(`"${VSWHERE}" -latest -property installationVersion`, { encoding: 'utf8' }).trim();
    return { installPath, version };
  } catch {
    throw new Error('Could not find Visual Studio installation via vswhere.');
  }
}

function areVsComponentsInstalled() {
  try {
    const output = execSync(
      `"${VSWHERE}" -latest -requires ${REQUIRED_VS_COMPONENTS[0]} -property installationPath`,
      { encoding: 'utf8' }
    ).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

function installVsComponents() {
  if (areVsComponentsInstalled()) {
    console.log('[VS] Spectre-mitigated libraries already installed.');
    return;
  }

  const info = getVsInstallInfo();
  console.log(`[VS] Installing Spectre-mitigated libraries for VS ${info.version}...`);

  const psCmd = `Start-Process -FilePath '${VS_INSTALLER}' -ArgumentList 'modify','--installPath','${info.installPath}','${REQUIRED_VS_COMPONENTS.map(c => `--add ${c}`).join("','")}','--quiet','--norestart' -Verb RunAs -Wait`;

  try {
    execSync(`powershell -Command "${psCmd.replace(/"/g, '\\"')}"`, {
      stdio: 'inherit',
      timeout: 600000,
    });
    console.log('[VS] Installation completed successfully.');
  } catch (err) {
    if (err.status === 3010) {
      console.log('[VS] Installation completed. A restart may be required.');
    } else {
      throw new Error(`VS component installation failed (exit code: ${err.status}).`);
    }
  }
}

// ============================================================
// Step 3: Build ONNX Runtime GenAI
// ============================================================

async function buildGenai() {
  if (!fs.existsSync(GENAI_PATH)) {
    throw new Error(`ONNX Runtime GenAI source not found at: ${GENAI_PATH}`);
  }

  const ortHome = path.join(ORT_INSTALL_DIR, BUILD_CONFIG);
  if (!fs.existsSync(ortHome)) {
    throw new Error(`ORT install not found at: ${ortHome}. Build ORT first.`);
  }

  // Ensure VS Spectre-mitigated libraries are installed
  installVsComponents();

  const cmd = [
    'python build.py',
    `--config ${BUILD_CONFIG}`,
    `--ort_home "${ortHome}"`,
    '--skip_tests',
    '--skip_wheel',
    '--skip_examples',
    '--parallel',
    '--update --build',
  ].join(' ');

  await runCommand(cmd, GENAI_PATH, 'GenAI Build');
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);

  // Parse --ep flag (e.g. --ep webgpu,cuda,web)
  const epIdx = args.indexOf('--ep');
  const eps = epIdx >= 0 && args[epIdx + 1]
    ? args[epIdx + 1].split(',')
    : ['webgpu'];  // default: webgpu only

  console.log(`[Config] EPs: ${eps.join(', ')}`);

  const startTime = Date.now();

  try {
    await buildOrt({ eps });
    await buildGenai();

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`\nCompleted in ${elapsed} minutes.`);
  } catch (err) {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  }
}

main();
