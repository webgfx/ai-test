/**
 * Shared utilities for perf test scripts.
 */

const { execSync } = require('child_process');
const os = require('os');

/**
 * Collect system information (CPU, GPU, memory, OS).
 * Uses nvidia-smi when available for GPU details.
 */
function getSystemInfo() {
  const info = {
    timestamp: new Date().toISOString(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model || 'Unknown',
    cpuCores: os.cpus().length,
    totalMemoryGB: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1),
    gpu: 'Unknown',
    gpuDriver: 'Unknown',
  };

  // Try to get GPU info via nvidia-smi
  try {
    const smi = execSync('nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits', { encoding: 'utf8', timeout: 10000 }).trim();
    const parts = smi.split(', ');
    if (parts.length >= 3) {
      info.gpu = parts[0];
      info.gpuDriver = parts[1];
      info.gpuMemoryMB = parts[2];
    }
  } catch {}

  return info;
}

module.exports = { getSystemInfo };
