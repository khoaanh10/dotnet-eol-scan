// Minimal assertions against the fixture repo. Run: node test/run.js
const assert = require('assert');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { scan, scanRepo, render, baseTfm, shouldFail } = require('..');
const fixture = path.join(__dirname, 'fixture');
const today = new Date('2026-10-24T00:00:00Z');
const f = scan(fixture, today, 90);
const by = (file, value) => f.find((x) => x.file === file && x.value === value);
let checks = 0;
const t = (fn) => { fn(); checks++; };

// v0.1 behaviour
t(() => assert.strictEqual(baseTfm('net9.0-windows'), 'net9.0'));
t(() => assert.ok(!f.some((x) => x.file.includes('bin/')), 'bin/ must be skipped'));
t(() => assert.strictEqual(by('Api/Api.csproj', 'net8.0').status, 'SOON'));
t(() => assert.strictEqual(by('Api/Api.csproj', 'net8.0').daysLeft, 17));
t(() => assert.strictEqual(by('Legacy/Legacy.csproj', 'v4.6.1').status, 'EOL'));
t(() => assert.strictEqual(by('Funcs/Funcs.csproj', 'net6.0').status, 'EOL'));
t(() => assert.strictEqual(by('Funcs/Funcs.csproj', 'in-process model').status, 'SOON'));
t(() => assert.strictEqual(by('Multi/Multi.csproj', 'net10.0').status, 'OK'));
t(() => assert.strictEqual(by('Multi/Multi.csproj', 'net9.0-windows').status, 'SOON'));
t(() => assert.strictEqual(by('Multi/Multi.csproj', 'netstandard2.0').status, 'OK'));
t(() => assert.strictEqual(by('global.json', '8.0').status, 'SOON'));
t(() => assert.strictEqual(by('Dockerfile', '9.0').status, 'SOON'));
t(() => assert.strictEqual(by('Dockerfile', '8.0').status, 'SOON'));
t(() => assert.strictEqual(f[0].status, 'EOL', 'EOL sorted first'));
t(() => assert.ok(render(f, 'md', today).includes('| Status | File |')));
t(() => assert.doesNotThrow(() => JSON.parse(render(f, 'json', today))));
// After the deadline net8.0 must flip to EOL
t(() => assert.strictEqual(scan(fixture, new Date('2026-11-11T00:00:00Z'), 90).find((x) => x.value === 'net8.0').status, 'EOL'));

// MSBuild properties: resolved from Directory.Build.props, otherwise INFO (not silently skipped)
t(() => assert.strictEqual(by('Props/Lib/Lib.csproj', 'net8.0').status, 'SOON'));
t(() => assert.match(by('Props/Lib/Lib.csproj', 'net8.0').note, /\$\(LibTfms\) in Props\/Directory\.Build\.props/));
t(() => assert.strictEqual(by('Props/Lib/Lib.csproj', 'net48 (v4.8)').status, 'INFO'));
t(() => assert.strictEqual(by('Props/Other/Other.csproj', '$(UndefinedTfms)').status, 'INFO'));
t(() => assert.strictEqual(by('Props/Other/Other.csproj', 'net10.0').status, 'OK'));
// Attributes on the element are allowed, XML comments are ignored
t(() => assert.strictEqual(by('Props/Cond/Cond.csproj', 'net7.0').status, 'EOL'));
t(() => assert.ok(!f.some((x) => x.file === 'Props/Cond/Cond.csproj' && x.value === 'net5.0'), 'commented-out TFM must be ignored'));
// SDK-style .NET Framework TFM; 4.6.2 ends 2027-01-12
t(() => assert.strictEqual(by('SdkFx/SdkFx.csproj', 'net462 (v4.6.2)').status, 'SOON'));
t(() => assert.strictEqual(by('SdkFx/SdkFx.csproj', 'net462 (v4.6.2)').eol, '2027-01-12'));
// packages.config
t(() => assert.strictEqual(by('Legacy/packages.config', '2 packages (net461)').status, 'INFO'));
// .sln only counts projects (solution folder excluded), adds no findings
const repo = scanRepo(fixture, today, 90);
t(() => assert.deepStrictEqual(repo.solutions, [{ file: 'Fixture.sln', projects: 3 }]));
t(() => assert.ok(!f.some((x) => x.file.endsWith('.sln'))));
t(() => assert.ok(render(repo.findings, 'text', today, repo.solutions).includes('Solutions: 1 (3 projects referenced)')));
// docker-compose images
t(() => assert.strictEqual(by('docker-compose.yml', '6.0').status, 'EOL'));
t(() => assert.strictEqual(by('docker-compose.yml', '${DOTNET_TAG}').status, 'INFO'));
t(() => assert.strictEqual(f.filter((x) => x.file === 'docker-compose.yml').length, 2, 'non-.NET images ignored'));
// GitHub Actions setup-dotnet: block list and matrix
const gh = f.filter((x) => x.file === '.github/workflows/ci.yml').map((x) => `${x.value}:${x.status}`).sort();
t(() => assert.deepStrictEqual(gh, ['10.0:OK', '6.0:EOL', '8.0:SOON', '9.0:SOON']));
// Azure Pipelines UseDotNet (useGlobalJson task adds nothing)
t(() => assert.deepStrictEqual(f.filter((x) => x.file === 'azure-pipelines.yml').map((x) => `${x.value}:${x.status}`), ['7.0:EOL']));

// --fail-on
const statuses = (...s) => s.map((status) => ({ status }));
t(() => assert.strictEqual(shouldFail(statuses('SOON', 'OK'), 'soon'), true));
t(() => assert.strictEqual(shouldFail(statuses('SOON', 'OK'), 'eol'), false));
t(() => assert.strictEqual(shouldFail(statuses('EOL'), 'eol'), true));
t(() => assert.strictEqual(shouldFail(statuses('EOL'), 'never'), false));

// CLI exit codes
const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js'), ...args], { encoding: 'utf8' });
t(() => assert.strictEqual(cli(fixture, '--date', '2026-10-24').status, 1, 'default fails on SOON'));
t(() => assert.strictEqual(cli(path.join(fixture, 'Multi'), '--date', '2026-10-24', '--fail-on', 'eol').status, 0, 'SOON only passes with --fail-on eol'));
t(() => assert.strictEqual(cli(fixture, '--fail-on', 'eol').status, 1));
t(() => assert.strictEqual(cli(fixture, '--fail-on', 'never').status, 0));
t(() => assert.strictEqual(cli(fixture, '--fail-on', 'bogus').status, 2));
t(() => assert.strictEqual(cli('--date', 'tomorrow').status, 2));
t(() => assert.strictEqual(cli('--warm-days', '5').status, 2, 'unknown option is an error, not a path'));
t(() => assert.strictEqual(cli(path.join(fixture, 'does-not-exist')).status, 2));
t(() => assert.match(execFileSync(process.execPath, [path.join(__dirname, '..', 'index.js'), '--help'], { encoding: 'utf8' }), /--fail-on/));
t(() => assert.strictEqual(JSON.parse(cli(fixture, '--json', '--fail-on', 'never').stdout).solutions[0].projects, 3));

console.log(`OK - ${f.length} findings, ${checks} assertions passed`);
