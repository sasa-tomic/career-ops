#!/usr/bin/env node

/**
 * setup-jobspy.mjs — one-command bootstrap for JobSpy board discovery.
 *
 * Creates a project-local Python venv (.venv-jobspy) and installs python-jobspy
 * into it. scan.mjs auto-detects this venv, so after running this you can set
 * `jobspy.enabled: true` in portals.yml and JobSpy runs as part of every scan.
 *
 * Usage:  npm run jobspy:setup   (or: node setup-jobspy.mjs)
 *
 * Idempotent: re-running upgrades python-jobspy in place. Fails loud with an
 * actionable message if Python 3 is missing — no silent partial setup.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const VENV = '.venv-jobspy';
const isWin = process.platform === 'win32';
const venvPython = isWin
  ? path.join(VENV, 'Scripts', 'python.exe')
  : path.join(VENV, 'bin', 'python');

function findSystemPython() {
  for (const bin of (isWin ? ['py', 'python', 'python3'] : ['python3', 'python'])) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch { /* try next */ }
  }
  return null;
}

function run(cmd, args) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit' });
}

console.log('Setting up JobSpy (python-jobspy) for career-ops...\n');

if (!existsSync(venvPython)) {
  const sys = findSystemPython();
  if (!sys) {
    console.error('\n❌ Python 3 not found. Install Python 3 (https://www.python.org/downloads/) and re-run "npm run jobspy:setup".');
    process.exit(1);
  }
  console.log(`Creating virtualenv ${VENV}/ ...`);
  run(sys, ['-m', 'venv', VENV]);
} else {
  console.log(`Reusing existing ${VENV}/`);
}

console.log('Installing python-jobspy ...');
try {
  run(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
  run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'python-jobspy']);
  execFileSync(venvPython, ['-c', 'import jobspy'], { stdio: 'ignore' });
} catch (err) {
  console.error(`\n❌ Install failed: ${err.message}`);
  console.error('   Check your network/proxy and re-run "npm run jobspy:setup".');
  process.exit(1);
}

console.log('\n✅ JobSpy is ready.');
console.log('   Set jobspy.enabled: true in portals.yml (the example ships it enabled).');
console.log('   Then: node scan.mjs   (JobSpy runs automatically as part of the scan)');
