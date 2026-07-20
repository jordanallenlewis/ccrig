#!/usr/bin/env node
'use strict';
/*
 * npm postinstall: wire CCRig's STATUS LINE into Claude Code automatically, so a
 * single `npm install -g ccrig` gets the bar without any extra step.
 *
 * Deliberately BAR-ONLY (--no-guardian): postinstall re-runs on every `npm update`,
 * so wiring the guardian here would silently re-enable it for someone who turned it
 * off. The guardian is opt-in-on-setup instead: `ccrig init` wires it (on by default).
 * Best-effort by design: it never fails the npm install (always exits 0), and it does
 * NOT run from the project's own source checkout, only from a real package install
 * (under node_modules, or a global install). Opt out entirely with CCRIG_NO_POSTINSTALL=1.
 */
const path = require('path');
const { spawnSync } = require('child_process');

function main() {
  if (process.env.CCRIG_NO_POSTINSTALL) return;
  // Wire only for a real install of the package, never the dev checkout.
  const packaged = /[\\/]node_modules[\\/]/.test(__dirname) || process.env.npm_config_global === 'true';
  if (!packaged) return;

  const result = spawnSync(process.execPath, [path.join(__dirname, 'statusline.js'), '--install', '--no-guardian'], {
    stdio: 'inherit',
  });

  if (!result || result.status !== 0) {
    process.stdout.write(
      '\nCCRig is installed. To set up your Claude Code status line, run:\n\n' +
      '  ccrig init\n\n' +
      'Then restart Claude Code once. (ccrig init is safe to run again any time.)\n\n'
    );
  }
}

try { main(); } catch (_) { /* never fail the npm install over setup */ }
process.exit(0);
