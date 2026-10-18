/** Browser stub — child_process is Node-only. */
export function spawnSync(): { status: number; stdout: Buffer; stderr: Buffer } {
  return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('spawnSync unavailable') };
}

export function execSync(): never {
  throw new Error('child_process.execSync is not available in the browser');
}

export function spawn(): never {
  throw new Error('child_process.spawn is not available in the browser');
}

export default { spawnSync, execSync, spawn };
