#!/usr/bin/env node
// dotnet-eol-scan: find .NET runtimes/SDKs in a repo that are out of support (or about to be).
// Zero dependencies. Run with --help for usage.
'use strict';
const fs = require('fs');
const path = require('path');
const VERSION = require('./package.json').version;

// End-of-support dates (last day of support).
// Source: https://dotnet.microsoft.com/platform/support/policy/dotnet-core (checked 2026-10-24)
const LIFECYCLE = {
  'netcoreapp1.0': '2019-06-27', 'netcoreapp1.1': '2019-06-27',
  'netcoreapp2.0': '2018-10-01', 'netcoreapp2.1': '2021-08-21', 'netcoreapp2.2': '2019-12-23',
  'netcoreapp3.0': '2020-03-03', 'netcoreapp3.1': '2022-12-13',
  'net5.0': '2022-05-10', 'net6.0': '2024-11-12', 'net7.0': '2024-05-14',
  'net8.0': '2026-11-10', 'net9.0': '2026-11-10', 'net10.0': '2028-11-14',
};
// Source: https://learn.microsoft.com/lifecycle/products/microsoft-net-framework (checked 2026-10-24)
// End dates there are given as 06:59 UTC the following day, i.e. end of day Pacific time.
// 4.7, 4.7.1, 4.7.2, 4.8, 4.8.1 have no end date: supported as a component of the Windows version they run on.
const FRAMEWORK_EOL = {
  'v2.0': '2011-07-12', 'v3.0': '2011-07-12',
  'v3.5': '2029-01-09', // 3.5 SP1 standalone (Windows 10 1809+ / Server 2019+); older Windows: follows the OS
  'v4.0': '2016-01-12', 'v4.0.3': '2016-01-12', 'v4.5': '2016-01-12', 'v4.5.1': '2016-01-12',
  'v4.5.2': '2022-04-26', 'v4.6': '2022-04-26', 'v4.6.1': '2022-04-26',
  'v4.6.2': '2027-01-12',
};
// Source: https://learn.microsoft.com/azure/azure-functions/migrate-dotnet-to-isolated-model
const FUNCTIONS_IN_PROCESS_EOL = '2026-11-10';

// Exchange Online SMTP AUTH (client submission, smtp.office365.com:587) Basic authentication.
// Sources (checked 2026-10-25):
//   https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835 (Exchange Team blog; page title confirmed, body not retrievable by the tool)
//   https://mc.merill.net/message/MC786329 (mirror of Microsoft 365 Message Center MC786329, updated 2026-01-27)
// Timeline: unchanged through December 2026; at the END OF DECEMBER 2026 Basic auth is disabled by default for existing
// tenants (admins can still re-enable it); final removal date to be announced in the second half of 2027.
// Microsoft gives only the month, so 2026-12-31 is used. Recommended: OAuth 2.0 (https://learn.microsoft.com/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth),
// High Volume Email for internal-only mail. Microsoft Graph sendMail is the usual app alternative (not named on MC786329).
const SMTP_BASIC_AUTH_DEFAULT_OFF = '2026-12-31';
const SMTP_HOST = /\b(smtp\.office365\.com|smtp-mail\.outlook\.com)\b/i;
const SMTP_OAUTH = /SaslMechanismOAuth2|XOAUTH2|Microsoft\.Graph|SendMail/i;
const SMTP_FILE = /\.(cs|vb|fs)$|^appsettings[\w.-]*\.json$|\.config$|\.env\.example$|\.ya?ml$/i;

const SKIP_DIRS = new Set(['node_modules', 'bin', 'obj', '.git', '.vs', 'packages', 'dist']);
const PROJECT_EXT = /\.(cs|fs|vb)proj$|^Directory\.Build\.props$/i;
const COMPOSE_FILE = /^(docker-)?compose[\w.-]*\.ya?ml$/i;
const YAML_FILE = /\.ya?ml$/i;
const FAIL_ON = { eol: ['EOL'], soon: ['EOL', 'SOON'], never: [] };

const HELP = `dotnet-eol-scan ${VERSION}
Find .NET target frameworks, SDK pins, Docker images and CI setups that are out of support or about to be.

Usage: dotnet-eol-scan [path] [options]

Options:
  --md                  Markdown report (good for PRs and GitHub job summaries)
  --json                JSON report
  --fail-on <level>     eol | soon | never   (default: soon)
                          eol   exit 1 only if something is already out of support
                          soon  exit 1 if something is out of support or ends within --warn-days
                          never always exit 0 (report only)
  --warn-days <N>       Days before end of support to report SOON (default: 90)
  --date <YYYY-MM-DD>   Evaluate as of this date instead of today
  -v, --version         Print version
  -h, --help            Print this help

Exit codes: 0 = pass, 1 = findings at or above --fail-on level, 2 = usage error.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { root: '.', format: 'text', today: new Date(), warnDays: 90, failOn: 'soon' };
  let rootSet = false;
  const value = (i, flag) => {
    if (i >= argv.length) throw new UsageError(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.format = 'json';
    else if (a === '--md') opts.format = 'md';
    else if (a === '--date') {
      const v = value(++i, a);
      opts.today = new Date(v + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(opts.today)) throw new UsageError(`Invalid --date "${v}", expected YYYY-MM-DD`);
    } else if (a === '--warn-days') {
      const v = value(++i, a);
      opts.warnDays = Number(v);
      if (!/^\d+$/.test(v)) throw new UsageError(`Invalid --warn-days "${v}", expected a whole number`);
    } else if (a === '--fail-on') {
      const v = value(++i, a).toLowerCase();
      if (!FAIL_ON[v]) throw new UsageError(`Invalid --fail-on "${v}", expected eol, soon or never`);
      opts.failOn = v;
    } else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a.startsWith('-')) throw new UsageError(`Unknown option ${a}`);
    else if (rootSet) throw new UsageError(`Only one path can be scanned, got "${opts.root}" and "${a}"`);
    else { opts.root = a; rootSet = true; }
  }
  return opts;
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(full); }
    else if (e.isFile()) yield full;
  }
}

const read = (file) => { try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return null; } };
const stripXmlComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

// Normalize "net8.0-windows", "net8.0-android34.0" -> "net8.0"
const baseTfm = (tfm) => tfm.trim().toLowerCase().split('-')[0];
// "8.0.404" / "8.0.x" / "8.x" / "8" -> "net8.0"; "3.1" -> "netcoreapp3.1"
function runtimeKey(version) {
  const m = String(version).match(/^v?(\d+)(?:\.(\d+|x))?/i);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] && m[2] !== 'x' ? Number(m[2]) : 0;
  return { key: major < 5 ? `netcoreapp${major}.${minor}` : `net${major}.${minor}`, label: `${major}.${minor}` };
}
// SDK-style .NET Framework TFMs: net48 -> v4.8, net462 -> v4.6.2, net35 -> v3.5
const frameworkFromShortTfm = (tfm) => {
  const m = tfm.match(/^net(\d)(\d)(\d)?$/);
  return m ? `v${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''}` : null;
};

function frameworkFinding(rel, value, source) {
  const eol = FRAMEWORK_EOL[value] || null;
  return {
    file: rel, kind: '.NET Framework', value: source ? `${source} (${value})` : value, eol,
    note: eol ? null : 'Supported as part of Windows; consider migrating to .NET 10 for new features',
  };
}

function tfmFinding(rel, tfm, via) {
  const t = tfm.trim();
  const base = baseTfm(t);
  const fx = frameworkFromShortTfm(base);
  if (fx) return frameworkFinding(rel, fx, t);
  const f = { file: rel, kind: 'TargetFramework', value: t, eol: LIFECYCLE[base] };
  if (via) f.note = `Resolved from ${via}`;
  if (!f.eol && /^net\d+\.\d+$/.test(base)) f.note = 'Version not in lifecycle table (preview or newer than this tool?)';
  return f;
}

// MSBuild properties visible to a project: its own, plus every Directory.Build.props from its folder up to the scan root.
function msbuildProperties(file, root, ownText) {
  const props = {};
  const collect = (text, from) => {
    for (const m of stripXmlComments(text).matchAll(/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g)) {
      if (!(m[1] in props)) props[m[1]] = { value: m[2].trim(), from };
    }
  };
  collect(ownText, path.basename(file));
  let dir = path.dirname(file);
  const stop = path.resolve(root);
  for (;;) {
    const props_ = path.join(dir, 'Directory.Build.props');
    if (props_ !== file) { const t = read(props_); if (t) collect(t, (path.relative(root, props_) || 'Directory.Build.props').split(path.sep).join('/')); }
    if (path.resolve(dir) === stop) break;
    const up = path.dirname(dir);
    if (up === dir || !path.resolve(up).startsWith(stop)) break;
    dir = up;
  }
  return props;
}

function projectFindings(file, rel, root, raw) {
  const out = [];
  const text = stripXmlComments(raw);
  let props;
  for (const m of text.matchAll(/<(TargetFrameworks?)(?:\s[^>]*)?>([^<]+)<\/\1>/gi)) {
    let value = m[2].trim();
    let via = null;
    if (value.includes('$(')) {
      props = props || msbuildProperties(file, root, raw);
      const used = [];
      value = value.replace(/\$\(([\w.-]+)\)/g, (all, name) => {
        const p = props[name];
        if (!p || p.value.includes('$(')) return all;
        used.push(`$(${name}) in ${p.from}`);
        return p.value;
      });
      via = used.join(', ') || null;
    }
    for (const tfm of value.split(';').map((t) => t.trim()).filter(Boolean)) {
      if (tfm.includes('$(')) {
        out.push({ file: rel, kind: m[1], value: tfm, eol: null, note: 'Set via an MSBuild property this tool cannot resolve; check the value manually' });
      } else out.push(tfmFinding(rel, tfm, via));
    }
  }
  for (const m of text.matchAll(/<TargetFrameworkVersion(?:\s[^>]*)?>([^<]+)<\/TargetFrameworkVersion>/gi)) {
    out.push(frameworkFinding(rel, m[1].trim()));
  }
  if (/Include\s*=\s*"Microsoft\.NET\.Sdk\.Functions"/i.test(text)) {
    out.push({ file: rel, kind: 'Azure Functions', value: 'in-process model', eol: FUNCTIONS_IN_PROCESS_EOL, note: 'Must move to isolated worker model before upgrading to .NET 10' });
  }
  return out;
}

function globalJsonFindings(rel, text) {
  let version;
  try { version = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')).sdk?.version; } catch {
    version = (text.match(/"sdk"\s*:\s*\{[^}]*?"version"\s*:\s*"([^"]+)"/) || [])[1];
  }
  const r = version && runtimeKey(version);
  return r ? [{ file: rel, kind: 'SDK pin (global.json)', value: r.label, eol: LIFECYCLE[r.key] }] : [];
}

function dockerImageFindings(rel, text) {
  const out = [];
  const re = /mcr\.microsoft\.com\/dotnet\/(?:core\/)?(sdk|aspnet|runtime-deps|runtime)(?::([^\s"'@]+))?/gi;
  for (const m of text.matchAll(re)) {
    const tag = m[2] || '';
    const v = tag.match(/^(\d+)\.(\d+)/);
    if (v) {
      const r = runtimeKey(`${v[1]}.${v[2]}`);
      out.push({ file: rel, kind: `Docker image (${m[1]})`, value: r.label, eol: LIFECYCLE[r.key] });
    } else {
      out.push({ file: rel, kind: `Docker image (${m[1]})`, value: tag || '(no tag)', eol: null, note: 'Tag is not a fixed version (variable, latest or missing); check which .NET version it resolves to' });
    }
  }
  return out;
}

const yamlScalar = (s) => s.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');

function versionFinding(rel, kind, raw) {
  const v = yamlScalar(raw);
  if (!v) return null;
  if (v.includes('${{') || v.includes('$(')) return { file: rel, kind, value: v, eol: null, note: 'Version comes from an expression/variable; check the matrix or variable values' };
  const r = runtimeKey(v);
  if (!r) return { file: rel, kind, value: v, eol: null, note: 'Unrecognised version format' };
  return { file: rel, kind, value: r.label, eol: LIFECYCLE[r.key] };
}

// Values of `name: [a, b]` or `name:\n  - a\n  - b` anywhere in the file (good enough for strategy.matrix).
function matrixValues(lines, name) {
  const key = new RegExp(`^(\\s*)${name.replace(/[-]/g, '\\-')}\\s*:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(key);
    if (!m) continue;
    const rest = m[2].replace(/\s+#.*$/, '').trim();
    if (rest.startsWith('[')) return rest.replace(/^\[|\]$/g, '').split(',').map(yamlScalar).filter(Boolean);
    if (rest) continue;
    const vals = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^(\s*)-\s*(.+)$/);
      if (!item || item[1].length < m[1].length) break;
      vals.push(yamlScalar(item[2]));
    }
    if (vals.length) return vals;
  }
  return null;
}

// actions/setup-dotnet:`dotnet-version: 8.0.x`, a quoted value, a block list (`|`) or a flow list (`['8.0.x', '9.0.x']`).
function githubActionsFindings(rel, text) {
  const out = [];
  const kind = 'GitHub Actions setup-dotnet';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)dotnet-version\s*:\s*(.*)$/);
    if (!m) continue;
    const rest = m[2].replace(/\s+#.*$/, '').trim();
    let values = [];
    if (/^[|>][-+]?$/.test(rest)) {
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (lines[j].match(/^\s*/)[0].length <= m[1].length) break;
        values.push(lines[j].trim());
      }
    } else if (rest.startsWith('[')) values = rest.replace(/^\[|\]$/g, '').split(',');
    else values = [rest];
    for (const v of values) {
      const mx = yamlScalar(v).match(/^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/);
      const resolved = mx && matrixValues(lines, mx[1]);
      for (const x of resolved || [v]) { const f = versionFinding(rel, kind, x); if (f) out.push(f); }
    }
  }
  return out;
}

// Azure Pipelines: `- task: UseDotNet@2` followed by `inputs: version: '8.0.x'`.
function azurePipelinesFindings(rel, text) {
  const out = [];
  const kind = 'Azure Pipelines UseDotNet';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(-\s*)?task\s*:\s*['"]?UseDotNet@\d/);
    if (!m) continue;
    const indent = m[1].length;
    let found = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      const ind = lines[j].match(/^\s*/)[0].length;
      if (ind < indent || (ind === indent && /^\s*-/.test(lines[j]))) break;
      const v = lines[j].match(/^\s*version\s*:\s*(.+)$/);
      if (v) { const f = versionFinding(rel, kind, v[1]); if (f) out.push(f); found = true; break; }
      if (/^\s*useGlobalJson\s*:\s*true/i.test(lines[j])) { found = true; break; }
    }
    if (!found) out.push({ file: rel, kind, value: '(no version)', eol: null, note: 'No version input; the task installs its default version' });
  }
  return out;
}

// Solutions are only counted (projects are scanned directly), so a report shows how much was found.
function solutionInfo(rel, name, text) {
  let projects;
  if (/\.slnx$/i.test(name)) projects = [...text.matchAll(/<Project\s[^>]*Path\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
  else projects = [...text.matchAll(/^Project\("\{([^}]+)\}"\)\s*=\s*"[^"]*",\s*"([^"]+)"/gm)]
    .filter((m) => m[1].toUpperCase() !== '2150E333-8FDC-42A3-9474-1A3956D46DE8') // solution folders
    .map((m) => m[2]);
  return { file: rel, projects: projects.filter((p) => /\.\w*proj$/i.test(p)).length };
}

function findingsForFile(file, root, solutions) {
  const rel = (path.relative(root, file) || path.basename(file)).split(path.sep).join('/');
  const name = path.basename(file);
  const isProject = PROJECT_EXT.test(name);
  const isDocker = /^dockerfile/i.test(name) || /\.dockerfile$/i.test(name) || /^containerfile$/i.test(name);
  const isGlobalJson = name.toLowerCase() === 'global.json';
  const isPackagesConfig = name.toLowerCase() === 'packages.config';
  const isSolution = /\.slnx?$/i.test(name);
  const isYaml = YAML_FILE.test(name);
  const isSmtpCandidate = SMTP_FILE.test(name);
  if (!isProject && !isDocker && !isGlobalJson && !isPackagesConfig && !isSolution && !isYaml && !isSmtpCandidate) return [];
  const text = read(file);
  if (text === null) return [];

  if (isProject) return projectFindings(file, rel, root, text);
  if (isGlobalJson) return globalJsonFindings(rel, text);
  if (isDocker) return dockerImageFindings(rel, text);
  if (isSolution) { solutions.push(solutionInfo(rel, name, text)); return []; }
  if (isPackagesConfig) {
    const body = stripXmlComments(text);
    const count = (body.match(/<package\s/gi) || []).length;
    const tfms = [...new Set([...body.matchAll(/targetFramework\s*=\s*"([^"]+)"/gi)].map((m) => m[1]))];
    return [{ file: rel, kind: 'packages.config', value: `${count} package${count === 1 ? '' : 's'}${tfms.length ? ' (' + tfms.join(', ') + ')' : ''}`, eol: null,
      note: 'packages.config is only used by .NET Framework projects; a move to .NET 10 also means moving to PackageReference' }];
  }
  const out = [];
  if (isSmtpCandidate) out.push(...smtpFindings(rel, text));
  if (COMPOSE_FILE.test(name)) out.push(...dockerImageFindings(rel, text));
  if (/(^|\/)\.github\/workflows\//.test(rel)) out.push(...githubActionsFindings(rel, text));
  if (/UseDotNet@/.test(text)) out.push(...azurePipelinesFindings(rel, text));
  return out;
}

// One finding per file; only host names are reported, never the matching line or any value around it.
function smtpFindings(rel, text) {
  const m = text.match(SMTP_HOST);
  if (!m) return [];
  const host = m[1].toLowerCase();
  if (SMTP_OAUTH.test(text)) return [{ file: rel, kind: 'Exchange Online SMTP AUTH', value: host, eol: null, note: 'OAuth detected — verify' }];
  return [{ file: rel, kind: 'Exchange Online SMTP AUTH', value: host, eol: SMTP_BASIC_AUTH_DEFAULT_OFF,
    note: 'Basic auth SMTP to Exchange Online is being retired (disabled by default for existing tenants at end of December 2026; final removal date TBA); move to OAuth 2.0 or Microsoft Graph' }];
}

function classify(f, today, warnDays) {
  if (!f.eol) return f.note ? 'INFO' : 'OK';
  const days = Math.ceil((new Date(f.eol + 'T00:00:00Z') - today) / 86400000);
  f.daysLeft = days;
  if (days <= 0) return 'EOL';
  if (days <= warnDays) return 'SOON';
  return 'OK';
}

// Returns { findings, solutions }.
function scanRepo(root, today = new Date(), warnDays = 90) {
  const findings = [];
  const solutions = [];
  for (const file of walk(root)) findings.push(...findingsForFile(file, root, solutions));
  for (const f of findings) f.status = classify(f, today, warnDays);
  const order = { EOL: 0, SOON: 1, INFO: 2, OK: 3 };
  findings.sort((a, b) => order[a.status] - order[b.status] || a.file.localeCompare(b.file));
  solutions.sort((a, b) => a.file.localeCompare(b.file));
  return { findings, solutions };
}

// Backwards compatible: findings only.
const scan = (root, today, warnDays) => scanRepo(root, today, warnDays).findings;

function render(findings, format, today, solutions = []) {
  const date = today.toISOString().slice(0, 10);
  if (format === 'json') return JSON.stringify({ scannedAt: date, tool: `dotnet-eol-scan ${VERSION}`, solutions, findings }, null, 2);
  const counts = findings.reduce((c, f) => ((c[f.status] = (c[f.status] || 0) + 1), c), {});
  const summary = `EOL: ${counts.EOL || 0} | Ending soon: ${counts.SOON || 0} | Info: ${counts.INFO || 0} | OK: ${counts.OK || 0}`;
  const projects = solutions.reduce((n, s) => n + s.projects, 0);
  const slnLine = solutions.length ? `Solutions: ${solutions.length} (${projects} project${projects === 1 ? '' : 's'} referenced)` : null;
  const when = (f) => (f.eol ? `${f.eol}${f.daysLeft !== undefined ? ` (${f.daysLeft > 0 ? f.daysLeft + ' days left' : 'ended ' + Math.abs(f.daysLeft) + ' days ago'})` : ''}` : '-');
  if (format === 'md') {
    const esc = (s) => String(s).replace(/\|/g, '\\|');
    const rows = findings.map((f) => `| ${f.status} | \`${esc(f.file)}\` | ${esc(f.kind)} | ${esc(f.value)} | ${when(f)} | ${esc(f.note || '')} |`);
    return [`# .NET support report (${date})`, '', summary, ...(slnLine ? ['', slnLine] : []), '',
      ...(findings.length ? ['| Status | File | Kind | Version | End of support | Note |', '|---|---|---|---|---|---|', ...rows] : ['No .NET projects found.'])].join('\n');
  }
  if (!findings.length) return ['No .NET projects found.', ...(slnLine ? [slnLine] : [])].join('\n');
  const lines = findings.map((f) => `[${f.status.padEnd(4)}] ${f.file}  ${f.kind}: ${f.value}  end of support: ${when(f)}${f.note ? '\n         ' + f.note : ''}`);
  return [...lines, '', summary, ...(slnLine ? [slnLine] : [])].join('\n');
}

const shouldFail = (findings, failOn) => findings.some((f) => FAIL_ON[failOn].includes(f.status));

function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`dotnet-eol-scan: ${e.message}\nRun with --help for usage.`);
    return 2;
  }
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.version) { console.log(VERSION); return 0; }
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`dotnet-eol-scan: "${opts.root}" is not a directory`);
    return 2;
  }
  const { findings, solutions } = scanRepo(root, opts.today, opts.warnDays);
  console.log(render(findings, opts.format, opts.today, solutions));
  return shouldFail(findings, opts.failOn) ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { scan, scanRepo, render, baseTfm, parseArgs, shouldFail, main, LIFECYCLE, FRAMEWORK_EOL };
