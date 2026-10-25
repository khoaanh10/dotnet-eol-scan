# dotnet-eol-scan

Find every .NET version in a repository that is out of support, or about to be. Zero dependencies, read-only, runs in seconds.

## Why

**.NET 8 and .NET 9 both reach end of support on 10 November 2026.** After that date they get no security patches. .NET 6 and 7 are already out of support, and so are .NET Framework 4.5.2–4.6.1. .NET Framework 4.6.2 follows on 12 January 2027.

The version a repo really runs on is spread across project files, `Directory.Build.props`, `global.json`, Dockerfiles, compose files and CI pipelines. This tool reads all of them and gives you one list.

## Quick start

Requires Node.js 18 or later. Nothing is installed into your project and nothing is sent anywhere.

```bash
# from the root of your .NET repository
npx github:khoaanh10/dotnet-eol-scan
```

Or without npm, from a clone of this repository:

```bash
node index.js /path/to/your/repo
```

## Example output

```text
[EOL ] Funcs/Funcs.csproj  TargetFramework: net6.0  end of support: 2024-11-12 (ended 711 days ago)
[EOL ] Legacy/Legacy.csproj  .NET Framework: v4.6.1  end of support: 2022-04-26 (ended 1642 days ago)
[EOL ] docker-compose.yml  Docker image (aspnet): 6.0  end of support: 2024-11-12 (ended 711 days ago)
[SOON] Api/Api.csproj  TargetFramework: net8.0  end of support: 2026-11-10 (17 days left)
[SOON] Funcs/Funcs.csproj  Azure Functions: in-process model  end of support: 2026-11-10 (17 days left)
         Must move to isolated worker model before upgrading to .NET 10
[SOON] .github/workflows/ci.yml  GitHub Actions setup-dotnet: 8.0  end of support: 2026-11-10 (17 days left)
[SOON] Mail/MailService.cs  Exchange Online SMTP AUTH: smtp.office365.com  end of support: 2026-12-31 (68 days left)
         Basic auth SMTP to Exchange Online is being retired (disabled by default for existing tenants at end of December 2026; final removal date TBA); move to OAuth 2.0 or Microsoft Graph
[SOON] Props/Lib/Lib.csproj  TargetFramework: net8.0  end of support: 2026-11-10 (17 days left)
         Resolved from $(LibTfms) in Props/Directory.Build.props
[INFO] Legacy/packages.config  packages.config: 2 packages (net461)  end of support: -
         packages.config is only used by .NET Framework projects; a move to .NET 10 also means moving to PackageReference
[OK  ] Multi/Multi.csproj  TargetFramework: net10.0  end of support: 2028-11-14 (752 days left)

EOL: 6 | Ending soon: 10 | Info: 4 | OK: 4
Solutions: 1 (3 projects referenced)
```

(Output from the test fixture in `test/fixture` with `--date 2026-10-24`; some lines removed, the summary is for the full run.)

| Status | Meaning |
|---|---|
| `EOL` | Out of support today. |
| `SOON` | Support ends within `--warn-days` (default 90). |
| `INFO` | Needs a human look: a value the tool cannot resolve, or a .NET Framework sign that has no end date. |
| `OK` | Supported beyond the warning window. |

## What it checks

| Source | What is read |
|---|---|
| `*.csproj`, `*.fsproj`, `*.vbproj`, `Directory.Build.props` | `<TargetFramework>`, `<TargetFrameworks>` (including `net48`-style .NET Framework TFMs), `<TargetFrameworkVersion>`, Azure Functions in-process (`Microsoft.NET.Sdk.Functions`) |
| MSBuild properties | `$(Prop)` values are resolved from the project and `Directory.Build.props` files above it; anything unresolved is reported as `INFO`, never skipped |
| `packages.config` | Reported as a .NET Framework sign, with the package count |
| `global.json` | `sdk.version` |
| `Dockerfile`, `*.dockerfile`, `docker-compose*.yml`, `compose*.yml` | `mcr.microsoft.com/dotnet/{sdk,aspnet,runtime,runtime-deps}` tags |
| `.github/workflows/*.yml` | `actions/setup-dotnet` `dotnet-version` (single value, list, or `${{ matrix.x }}`) |
| Any `*.yml` with `UseDotNet@` | Azure Pipelines `UseDotNet` task `version` |
| `*.cs`, `*.vb`, `*.fs`, `appsettings*.json`, `*.config`, `*.env.example`, `*.yml`/`*.yaml` | References to `smtp.office365.com` / `smtp-mail.outlook.com` (Exchange Online SMTP AUTH). One finding per file, host name only, never the matching line or any credential. Files that also show OAuth (`SaslMechanismOAuth2`, `XOAUTH2`, `Microsoft.Graph`, `SendMail`) are `INFO` ("OAuth detected — verify") |
| `*.sln`, `*.slnx` | Only counted, to show how many projects the solutions reference |

`bin`, `obj`, `node_modules`, `packages`, `.git`, `.vs` and `dist` folders are skipped.

## Options

```text
dotnet-eol-scan [path] [options]

  --md                  Markdown report (good for PRs and GitHub job summaries)
  --json                JSON report
  --fail-on <level>     eol | soon | never   (default: soon)
  --warn-days <N>       Days before end of support to report SOON (default: 90)
  --date <YYYY-MM-DD>   Evaluate as of this date instead of today
  -v, --version         Print version
  -h, --help            Print help
```

Exit codes: `0` pass, `1` something at or above the `--fail-on` level was found, `2` usage error.

- `--fail-on soon` (default): fail if anything is out of support or ends within `--warn-days`.
- `--fail-on eol`: fail only if something is already out of support.
- `--fail-on never`: report only, always exit 0.

## Use in GitHub Actions

Copy [`examples/github-action.yml`](examples/github-action.yml) to `.github/workflows/dotnet-eol.yml`. It runs on pull requests, on pushes to `main` and once a week (dates move even when the code does not), writes the Markdown report to the job summary and fails the job when something is out of support.

The key step:

```yaml
- name: Scan for end-of-life .NET versions
  shell: bash
  run: npx --yes github:khoaanh10/dotnet-eol-scan#v0.2.0 . --md --fail-on eol | tee -a "$GITHUB_STEP_SUMMARY"
```

## Limitations

- It reads files as text. It does not run MSBuild, restore packages or evaluate `Condition`s, so a TFM selected by a condition is reported as if it always applies.
- Properties set from the command line, environment variables, `.targets` files or `Directory.Build.targets` are not resolved; such values show up as `INFO`.
- Only Microsoft's official `mcr.microsoft.com/dotnet/*` images are recognised. Third-party base images and floating tags such as `latest` are not resolved.
- It checks the .NET runtime and SDK, not NuGet packages. Use `dotnet list package --vulnerable` and `dotnet list package --outdated` for those.
- `netstandard*` is a library target, not a runtime; it is listed as `OK`.
- .NET Framework 4.7–4.8.1 have no fixed end date (they follow the Windows version they run on), so they are shown as `INFO`.
- Exchange Online SMTP AUTH: Microsoft says Basic auth is disabled by default for existing tenants at the end of December 2026 (admins can re-enable it) and will announce the final removal date in the second half of 2027. Microsoft gives only the month, so the tool uses 2026-12-31 and the column "end of support" means "disabled by default" for this check. Detection is text-only: a host name in a file does not prove Basic auth is used, and OAuth detection is a keyword match, hence `INFO`. See the [Exchange Team announcement](https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835).
- The support dates are built into the tool (see the sources in `index.js`). Check the [official .NET support policy](https://dotnet.microsoft.com/platform/support/policy/dotnet-core) and [.NET Framework lifecycle](https://learn.microsoft.com/lifecycle/products/microsoft-net-framework) for anything critical, and update the tool when new versions ship.

## Development

```bash
npm test
```

Issues and pull requests are welcome, especially fixture files from real-world repos the scanner gets wrong.

## License

[MIT](LICENSE)

---

Need help upgrading a .NET app? Fixed-price upgrades to .NET 10 → [LTS Lift](https://khoaanh10.github.io/ltslift/)
