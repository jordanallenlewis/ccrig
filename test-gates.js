#!/usr/bin/env node
/*
 * Quality gates for ccrig. Zero dependencies (node:test, Node 18+). Auto-discovered by
 * `node --test` alongside test.js / test-unit.js, so it needs no CI change. One file, one
 * shared rule source, covering the three authored output surfaces:
 *   - docs + CLI literals: a plain-voice scan (no em-dash, no AI-tell vocabulary)
 *   - config SSOT: the example config must match the DEFAULTS object, and every CONFIG.<key>
 *     the code reads must exist in DEFAULTS
 *   - flags: README and --help must document the same set of flags
 * The scanners read the EXPORTED DEFAULTS / helpText (the code SSOT), so a gate cannot drift
 * from what the code actually does.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SL = require('./statusline.js');
const R = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const DOCS = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];

// the ONE shared rule source (extend here; both the docs scan and the literal scan consume it)
const BANNED = [
  { re: /—/, name: 'em-dash' },
  { re: /\b(delv(?:e|es|ing)|seamless(?:ly)?|robust(?:ly|ness)?|comprehensive(?:ly)?|empowers?|empowering|leverag(?:e|es|ed|ing)|streamlin(?:e|ed|ing)|effortless(?:ly)?|cutting[- ]edge|game[- ]?chang\w*|blazing(?:ly)?|supercharged?)\b/i, name: 'AI-tell' },
];

function scanLines(label, text) {
  const hits = [];
  text.split('\n').forEach((line, i) => { for (const b of BANNED) if (b.re.test(line)) hits.push(`${label}:${i + 1} ${b.name}: ${line.trim().slice(0, 80)}`); });
  return hits;
}

// ---- GATE-01: docs voice + CLI-literal voice --------------------------------
test('GATE: docs have no em-dash or AI-tell vocabulary', () => {
  const hits = DOCS.flatMap((f) => scanLines(f, R(f)));
  assert.strictEqual(hits.length, 0, 'banned tells in docs:\n' + hits.join('\n'));
});

test('GATE: statusline.js string literals (comments excluded) have no banned tells', () => {
  // strip block + line comments first (the source comments intentionally use em-dashes), then scan
  // only string literals. The [^:] guard before // keeps :// in URLs inside literals from being cut.
  const src = R('statusline.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const lits = src.match(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g) || [];
  const hits = [];
  for (const lit of lits) for (const b of BANNED) if (b.re.test(lit)) hits.push(`${b.name}: ${lit.slice(0, 80)}`);
  assert.strictEqual(hits.length, 0, 'banned tells in CLI literals:\n' + hits.join('\n'));
});

// ---- GATE-02: example config matches DEFAULTS (the SSOT) ---------------------
function flatten(o, p, out) {
  for (const k of Object.keys(o)) {
    if (k.startsWith('_')) continue;                 // _comment / _guardian etc are doc-only
    const key = p ? p + '.' + k : k;
    const v = o[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}
test('GATE: statusline.config.example.json matches DEFAULTS', () => {
  const ALLOW_DIFFERENT = new Set(['profileLabels']); // example documents sample labels in _profileLabels; ships {}
  const def = flatten(SL.DEFAULTS, '', {});
  const ex = flatten(JSON.parse(R('statusline.config.example.json')), '', {});
  const defKeys = new Set(Object.keys(def)), exKeys = new Set(Object.keys(ex));
  const missing = [...defKeys].filter((k) => !exKeys.has(k));
  const extra = [...exKeys].filter((k) => !defKeys.has(k));
  assert.strictEqual(missing.length, 0, 'example is MISSING keys from DEFAULTS: ' + missing.join(', '));
  assert.strictEqual(extra.length, 0, 'example has keys NOT in DEFAULTS: ' + extra.join(', '));
  const valueDrift = [...defKeys].filter((k) => !ALLOW_DIFFERENT.has(k.split('.')[0]) && def[k] !== ex[k]);
  assert.strictEqual(valueDrift.length, 0, 'example values drift from DEFAULTS: ' + valueDrift.map((k) => `${k} (${ex[k]} != ${def[k]})`).join(', '));
  assert.deepStrictEqual(JSON.parse(R('statusline.config.example.json')).order, SL.DEFAULT_ORDER, 'example order must equal DEFAULT_ORDER');
});

// ---- GATE-03: every CONFIG.<key> the code reads exists in DEFAULTS -----------
test('GATE: every CONFIG.<key> read exists in DEFAULTS', () => {
  const keys = new Set([...R('statusline.js').matchAll(/CONFIG\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
  const orphans = [...keys].filter((k) => !(k in SL.DEFAULTS));
  assert.strictEqual(orphans.length, 0, 'CONFIG keys read but absent from DEFAULTS: ' + orphans.join(', '));
});

// ---- GATE-04: README <-> --help flag parity ---------------------------------
test('GATE: README and --help document the same flags', () => {
  // internal/never-user-typed ccrig flags + external tool flags (claude/node) documented in prose
  const ALLOWLIST = new Set(['--hook', '--watch', '--continue', '--resume', '--check']);
  const helpFlags = new Set((SL.helpText().match(/--[a-z][a-z-]+/g) || []));
  const readmeFlags = new Set((R('README.md').match(/--[a-z][a-z-]+/g) || []));
  const missingFromReadme = [...helpFlags].filter((f) => !ALLOWLIST.has(f) && !readmeFlags.has(f));
  const missingFromHelp = [...readmeFlags].filter((f) => !ALLOWLIST.has(f) && !helpFlags.has(f));
  assert.strictEqual(missingFromReadme.length, 0, 'flags in --help but not in README: ' + missingFromReadme.join(', '));
  assert.strictEqual(missingFromHelp.length, 0, 'flags in README but not in --help: ' + missingFromHelp.join(', '));
});

// ---- gate for SHELL-01: the shellcheck directive cannot be dropped ----------
test('GATE: claude-profiles.sh keeps its shellcheck shell directive', () => {
  assert.match(R('claude-profiles.sh').split('\n')[0], /^# shellcheck shell=bash/);
});

// ---- gate: package.json stays consistent with the code (SSOT) + zero-dependency ----
test('GATE: package.json version matches VERSION, bin points at the script, no dependencies', () => {
  const pkg = JSON.parse(R('package.json'));
  assert.strictEqual(pkg.version, SL.VERSION, 'package.json version must equal statusline.js VERSION (npm publish would drift otherwise)');
  assert.strictEqual(pkg.bin && pkg.bin.ccrig, 'statusline.js', 'the ccrig bin must point at statusline.js');
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('statusline.js'), 'files must ship statusline.js');
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'must stay zero-dependency (C1)');
});
