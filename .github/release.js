#!/usr/bin/env node
// Cut a CCRig release in one command. Everything after the push is CI's job (release.yml):
// tests on three OSes and the mod suite, then the GitHub Release and the npm publish (Trusted
// Publishing, no token). The plugin marketplace follows the tag pinned in marketplace.json.
//
//   npm run release -- patch|minor|major|X.Y.Z [--dry-run] [--no-test]
//
// Preconditions it checks: on main, a clean tree, in step with origin/main, and something under
// "## [Unreleased]" in CHANGELOG.md. It bumps statusline.js, package.json, the plugin manifest and the
// marketplace pin together (a test fails the build when they disagree), turns [Unreleased] into the
// dated version, runs the tests, commits, tags, and pushes the commit and tag in one atomic push.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NO_TEST = args.includes('--no-test');
const bump = args.find((a) => !a.startsWith('--'));

const die = (msg) => { process.stderr.write('release: ' + msg + '\n'); process.exit(1); };
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const write = (f, s) => { if (!DRY) fs.writeFileSync(path.join(ROOT, f), s); };

if (!bump) die('usage: npm run release -- patch|minor|major|X.Y.Z [--dry-run] [--no-test]');

// ---- preconditions ----
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') die('releases are cut from main');
if (git('status', '--porcelain')) die('the working tree is not clean; commit or stash first');
git('fetch', '--no-tags', 'origin', 'main');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) die('main is not in step with origin/main; pull or push first');

const pkg = JSON.parse(read('package.json'));
const cur = pkg.version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur);
if (!m) die('package.json version is not x.y.z: ' + cur);
const [maj, min, pat] = m.slice(1).map(Number);
const next = bump === 'major' ? `${maj + 1}.0.0` : bump === 'minor' ? `${maj}.${min + 1}.0` : bump === 'patch' ? `${maj}.${min}.${pat + 1}`
  : /^\d+\.\d+\.\d+$/.test(bump) ? bump : die('unknown bump "' + bump + '" (patch, minor, major or X.Y.Z)');
const gt = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
if (!gt(next, cur)) die(`${next} is not newer than ${cur}`);
let tagged = true;
try { git('rev-parse', '-q', '--verify', 'refs/tags/v' + next); } catch { tagged = false; }
if (tagged) die('tag v' + next + ' already exists');

const changelog = read('CHANGELOG.md');
const un = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[)/.exec(changelog);
if (!un || !un[1].trim()) die('nothing under "## [Unreleased]" in CHANGELOG.md; describe the release there first');

// ---- bump every version together ----
const today = new Date().toISOString().slice(0, 10);
const swap = (file, from, to) => { const s = read(file); if (!s.includes(from)) die(file + ': could not find ' + from); write(file, s.replace(from, to)); };
swap('statusline.js', `const VERSION = '${cur}';`, `const VERSION = '${next}';`);
swap('package.json', `"version": "${cur}"`, `"version": "${next}"`);
swap('.claude-plugin/plugin.json', `"version": "${cur}"`, `"version": "${next}"`);
swap('.claude-plugin/marketplace.json', `"ref": "v${cur}"`, `"ref": "v${next}"`);
write('CHANGELOG.md', changelog.replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${next}] - ${today}\n`));

const notes = un[1].trim();
const headline = (notes.match(/^- \*\*(.+?)\*\*/m) || [])[1] || (notes.match(/^- (.+)$/m) || [])[1] || 'release';
const subject = `release: ${next} (${headline.replace(/[.:]+$/, '').slice(0, 72)})`;
process.stdout.write(`${cur} -> ${next}\n${subject}\n`);
if (DRY) { process.stdout.write('\n--dry-run: nothing written, committed or pushed.\n'); process.exit(0); }

// ---- gates, then ship ----
if (!NO_TEST) {
  // npm is npm.cmd on Windows (needs a shell); node runs directly, since its path can hold a space
  const inherit = { cwd: ROOT, stdio: 'inherit' };
  try {
    execFileSync('npm', ['test'], { ...inherit, shell: process.platform === 'win32' });
    execFileSync(process.execPath, ['statusline.js', '--selftest'], inherit);
  } catch {
    git('checkout', '--', '.');
    die('the gates failed; the version bump was undone');
  }
}
git('add', 'statusline.js', 'package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'CHANGELOG.md');
execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: ROOT, input: subject + '\n\n' + notes + '\n' });
git('tag', '-a', 'v' + next, '-m', 'v' + next);
// one atomic push: the marketplace pin on main never names a tag that is not there yet
execFileSync('git', ['push', '--atomic', 'origin', 'main', 'v' + next], { cwd: ROOT, stdio: 'inherit' });
process.stdout.write(`\nPushed v${next}. CI now tests it and publishes the GitHub Release and npm package.\n` +
  `Watch: gh run watch $(gh run list --workflow release.yml -L 1 --json databaseId --jq '.[0].databaseId')\n`);
