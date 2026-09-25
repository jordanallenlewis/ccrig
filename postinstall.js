#!/usr/bin/env node
'use strict';
/*
 * npm postinstall: wire CCRig's STATUS LINE into Claude Code automatically, so a
 * single `npm install -g ccrig` gets the bar without any extra step.
 *
 * Deliberately BAR-ONLY (--no-guardian): postinstall re-runs on every `npm update`,
 * so wiring the guardian here would silently re-enable it for someone who turned it
 * off. The guardian is opt-in-on-setup instead: `ccrig init` wires it (on by default).
 * Best-effort by design: it never fails the npm install (always exits 0), and it runs only
 * for a real global install: not the source checkout, not a project dependency, not npx,
 * not as root. Opt out entirely with CCRIG_NO_POSTINSTALL=1.
 */
const path = require('path');
const { spawnSync } = require('child_process');

function main() {
  if (process.env.CCRIG_NO_POSTINSTALL) return;
  // Wire only for a real GLOBAL install. Never the dev checkout, never a project's local node_modules,
  // and never `npx ccrig --demo` (the README's "preview before installing"), which unpacks into npm's
  // _npx cache: wiring that would replace the user's status line with a path npm later deletes.
  const dir = __dirname;
  if (/[\\/]_npx[\\/]/.test(dir) || process.env.npm_command === 'exec') return;
  const global = process.env.npm_config_global === 'true' || /[\\/](pnpm|yarn)[\\/].*[\\/]global[\\/]/i.test(dir);
  if (!global || !/[\\/]node_modules[\\/]/.test(dir)) return;
  // `sudo npm install -g` would write root-owned files into the user's ~/.claude, which then breaks
  // Claude Code itself. Leave setup to the user's own `ccrig init`.
  if (typeof process.getuid === 'function' && process.getuid() === 0) return hint();

  // refresh mode: wire the bar, and re-point a guardian that is already wired, never add or drop one
  const result = spawnSync(process.execPath, [path.join(__dirname, 'statusline.js'), '--install', '--no-guardian'], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { CCBSL_REFRESH: '1' }),
  });

  if (!result || result.status !== 0) hint();
}
function hint() {
  process.stdout.write(
    '\nCCRig is installed. To set up your Claude Code status line, run:\n\n' +
    '  ccrig init\n\n' +
    'Then restart Claude Code once. (ccrig init is safe to run again any time.)\n\n'
  );
}

try { main(); } catch (_) { /* never fail the npm install over setup */ }
process.exit(0);
