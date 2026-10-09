$ErrorActionPreference = 'Stop'
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "herdr web ui needs Bun 1.4 or newer. Install it from https://bun.sh, then retry from a terminal where 'bun --version' works."
}
$bunVersion = (& bun --version) -replace '-.*$', ''
if ($LASTEXITCODE -ne 0 -or [version]$bunVersion -lt [version]'1.4.0') {
    throw "herdr web ui needs Bun 1.4 or newer; this is $bunVersion. Update Bun and run this again."
}
# Windows uses herdr's screen mirror, so no Node terminal sidecar is needed.
