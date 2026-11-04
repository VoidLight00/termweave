# Windows PowerShell 5.1 tests for install.ps1 (no Pester). Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-install.test.ps1
# Every run of install.ps1 here uses TERMWEAVE_INSTALL_TEST_MODE=1: the Machine/User Path come from fixture variables (the real
# registry is never read or written), the official installers are replaced by local file: fixtures, the install mutex gets a
# per-run name suffix, and profile/temp directories point into a temp base. Most cases run a copy of install.ps1 next to a
# recording stand-in for scripts/install-lifecycle.ts; the --check snapshot case also runs the real install.ps1 and TS entry.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$Installer = Join-Path $Repo 'install.ps1'
$Shell = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
$Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$Suffix = 'test-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$MutexName = "Global\TermWeave.Install.$Sid.$Suffix"
$Base = Join-Path ([IO.Path]::GetTempPath()) ('tw-winst-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Base = [IO.Directory]::CreateDirectory($Base).FullName.TrimEnd('\')

function Find-RealTool([string]$Name, [string[]]$Fallback) {
  $command = Get-Command "$Name.exe" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  foreach ($candidate in $Fallback) { if ([IO.File]::Exists($candidate)) { return $candidate } }
  throw "$Name.exe is required to run these tests"
}
$RealBun = Find-RealTool 'bun' @((Join-Path $env:USERPROFILE '.bun\bin\bun.exe'))
$RealGit = Find-RealTool 'git' @('C:\Program Files\Git\cmd\git.exe')
$BunDir = Split-Path -Parent $RealBun
$GitDir = Split-Path -Parent $RealGit

# ---- harness ------------------------------------------------------------------
$script:Passed = 0
$script:Failed = 0
$script:Started = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "assertion failed: $Message" } }
function Assert-Equal($Expected, $Actual, [string]$Message) { if (-not ([string]$Expected -ceq [string]$Actual)) { throw "assertion failed: $Message`n        expected: $Expected`n        actual:   $Actual" } }
function Assert-Contains([string]$Text, [string]$Part, [string]$Message) { if (-not $Text.Contains($Part)) { throw "assertion failed: $Message`n        missing:  $Part`n        in:       $Text" } }
# TW_INSTALL_TEST_FILTER (a substring of a case name) runs only the matching cases. After every case, passed or failed, the
# processes it started are stopped and the install mutex must be free: no case depends on an earlier case's cleanup, and a leaked
# holder fails the case that leaked it instead of every later one.
function Test-Case([string]$Name, [scriptblock]$Body) {
  $filter = [Environment]::GetEnvironmentVariable('TW_INSTALL_TEST_FILTER', 'Process')
  if ($filter -and -not $Name.Contains($filter)) { return }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $first = $script:Started.Count
  $failures = @(try { $null = & $Body } catch { $_ }) + @(try { Stop-Started $first; Assert-MutexFree 'after the case stopped its processes' } catch { $_ })
  if ($failures.Count -eq 0) { $script:Passed++; Write-Host "ok    $Name ($($watch.ElapsedMilliseconds) ms)"; return }
  $script:Failed++; Write-Host "FAIL  $Name ($($watch.ElapsedMilliseconds) ms)"
  foreach ($failure in $failures) { Write-Host "      $($failure.Exception.Message)"; Write-Host "      $($failure.InvocationInfo.PositionMessage)" }
}
# Kills (and reaps) a test child that is still running.
function Stop-Run([System.Diagnostics.Process]$Process) {
  if (-not $Process.HasExited) { try { $Process.Kill() } catch { if (-not $Process.HasExited) { throw } } }
  if (-not $Process.WaitForExit(60000)) { throw "process $($Process.Id) did not exit within 60 s of being killed" }
}
function Stop-Started([int]$From) { for ($i = $From; $i -lt $script:Started.Count; $i++) { Stop-Run $script:Started[$i] } }
# The install mutex is free right now: acquired without waiting (an abandoned one counts, its owner is gone) and released again.
# Still held means a leaked holder or install.ps1 run, which would make every later changing call wait and fail.
function Assert-MutexFree([string]$When) {
  $mutex = New-Object System.Threading.Mutex($false, $MutexName)
  try {
    $free = try { $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $true }
    if (-not $free) { throw "the install mutex $MutexName is still held $When" }
    $mutex.ReleaseMutex()
  } finally { $mutex.Dispose() }
}
# Bound for a child to get going (powershell.exe startup alone took minutes on a loaded runner); waits end when the signal appears.
$StartupMs = 180000
function Wait-Until([string]$What, [scriptblock]$Condition, [int]$TimeoutMs) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while (-not (& $Condition)) { if ([DateTime]::UtcNow -ge $deadline) { throw "timed out waiting for $What" }; Start-Sleep -Milliseconds 100 }
}
function ConvertTo-ArgumentText([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $text = New-Object System.Text.StringBuilder
  $null = $text.Append('"'); $slashes = 0
  foreach ($char in $Value.ToCharArray()) {
    if ($char -eq [char]'\') { $slashes++; continue }
    if ($char -eq [char]'"') { $null = $text.Append([char]'\', 2 * $slashes + 1); $null = $text.Append('"'); $slashes = 0; continue }
    if ($slashes -gt 0) { $null = $text.Append([char]'\', $slashes); $slashes = 0 }
    $null = $text.Append($char)
  }
  if ($slashes -gt 0) { $null = $text.Append([char]'\', 2 * $slashes) }
  $null = $text.Append('"')
  return $text.ToString()
}
# Starts powershell.exe with exactly $Vars as its environment and both output streams captured.
function Start-PowerShell([string[]]$Arguments, [hashtable]$Vars, [string]$WorkDir = $Work) {
  $info = New-Object System.Diagnostics.ProcessStartInfo $Shell
  $info.Arguments = (@(@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass') + $Arguments | ForEach-Object { ConvertTo-ArgumentText $_ }) -join ' ')
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $info.WorkingDirectory = $WorkDir
  $info.EnvironmentVariables.Clear()
  foreach ($name in $Vars.Keys) { $info.EnvironmentVariables[$name] = [string]$Vars[$name] }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $process = [System.Diagnostics.Process]::Start($info)
  $script:Started.Add($process)
  return [pscustomobject]@{ Process = $process; Out = $process.StandardOutput.ReadToEndAsync(); Err = $process.StandardError.ReadToEndAsync(); Watch = $watch; Record = $Vars['TW_TEST_RECORD'] }
}
function Complete-PowerShell($Run, [int]$TimeoutMs = 120000) {
  if (-not $Run.Process.WaitForExit($TimeoutMs)) { $Run.Process.Kill(); throw "powershell.exe did not exit within $TimeoutMs ms" }
  $Run.Process.WaitForExit()
  return [pscustomobject]@{ Code = $Run.Process.ExitCode; Out = $Run.Out.Result; Err = $Run.Err.Result; Ms = $Run.Watch.ElapsedMilliseconds; Records = @(Read-Records $Run.Record) }
}
function Invoke-Installer([string[]]$Arguments, [hashtable]$Vars, [string]$Script = $FixtureInstaller) { Complete-PowerShell (Start-PowerShell (@('-File', $Script) + $Arguments) $Vars) }
# The complete (newline-terminated) JSON lines of $File. Shared with writers that still have it open (the stand-in TS appends one
# whole line per record): ReadAllLines' FileShare.Read fails against an open writer, and a line still being written is not taken.
function Read-Records([string]$File) {
  if (-not $File -or -not [IO.File]::Exists($File)) { return @() }
  $stream = New-Object IO.FileStream($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try { $text = (New-Object IO.StreamReader($stream)).ReadToEnd() } finally { $stream.Dispose() }
  return @($text.Substring(0, $text.LastIndexOf("`n") + 1).Split("`n") | ForEach-Object { $_.TrimEnd("`r") } | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
}
function Get-Argv($Record) { return (@($Record.argv) -join '|') }

# ---- fixture tree ---------------------------------------------------------------
$HomeDir = Join-Path $Base 'home'
$Temp = Join-Path $Base 'temp'
$Work = Join-Path $Base 'work'
$Records = Join-Path $Base 'records'
$Markers = Join-Path $Base 'markers'
$Src = Join-Path $Base 'src'
$Tools = Join-Path $Base 'tools'
foreach ($dir in @($HomeDir, (Join-Path $HomeDir 'AppData\Local'), (Join-Path $HomeDir 'AppData\Roaming'), $Temp, $Work, $Records, $Markers, (Join-Path $Src 'scripts'), (Join-Path $Tools 'herdr'), (Join-Path $Base 'installers'))) { $null = [IO.Directory]::CreateDirectory($dir) }
$FixtureInstaller = Join-Path $Src 'install.ps1'
Copy-Item -LiteralPath $Installer -Destination $FixtureInstaller
# Stand-in for scripts/install-lifecycle.ts: records argv, the Path key(s) and cwd; TW_TEST_HOLD_<CMD> ms delay, TW_TEST_EXIT_<CMD> exit code.
[IO.File]::WriteAllText((Join-Path $Src 'scripts\install-lifecycle.ts'), @'
import {appendFileSync} from 'node:fs';
const env=process.env,command=(process.argv[2]??'').toUpperCase();
appendFileSync(env.TW_TEST_RECORD!,JSON.stringify({argv:process.argv.slice(2),pathKeys:Object.keys(env).filter(key=>key.toUpperCase()==='PATH'),path:env.Path??null,cwd:process.cwd(),at:Date.now()})+'\n');
const hold=Number(env[`TW_TEST_HOLD_${command}`]??0);if(hold)await Bun.sleep(hold);
process.exit(Number(env[`TW_TEST_EXIT_${command}`]??0));
'@)
# herdr stand-in for the real TS check (TS runs `herdr --version`); the fixture installers below.
[IO.File]::WriteAllText((Join-Path $Tools 'herdr\herdr.cmd'), "@echo herdr 0.9.1`r`n")
$InstallerLog = Join-Path $Markers 'installers.log'
function New-InstallerFixture([string]$Name, [string]$Body) { $path = Join-Path $Base "installers\$Name.ps1"; [IO.File]::WriteAllText($path, $Body); return ([Uri]$path).AbsoluteUri }
$StateProbe = @'
$strict = $true; try { $null = $twNeverAssignedVariable; $strict = $false } catch { }
$state = @{ tool = '{TOOL}'; tls12 = ([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12) -ne 0; strict = $strict; eap = [string]$ErrorActionPreference; policy = [string]$env:PSExecutionPolicyPreference }
Add-Content -LiteralPath (Join-Path $env:TW_FIXTURE_ROOT 'markers\installers.log') -Value ($state | ConvertTo-Json -Compress)
'@
$BunOkUrl = New-InstallerFixture 'bun-ok' ($StateProbe.Replace('{TOOL}', 'bun') + "`r`n" + @'
$dir = Join-Path $env:TW_FIXTURE_ROOT 'installed\bun\bin'
$null = New-Item -ItemType Directory -Force -Path $dir
try { $null = New-Item -ItemType HardLink -Path (Join-Path $dir 'bun.exe') -Target $env:TW_REAL_BUN } catch { Copy-Item -LiteralPath $env:TW_REAL_BUN -Destination (Join-Path $dir 'bun.exe') }
# The official installers may change their own session freely; none of it may reach install.ps1.
Set-StrictMode -Version Latest; $ErrorActionPreference = 'SilentlyContinue'
exit 0
'@)
$HerdrOkUrl = New-InstallerFixture 'herdr-ok' $StateProbe.Replace('{TOOL}', 'herdr')
$FailUrl = New-InstallerFixture 'fail' "Write-Output 'fixture installer failing'`r`nexit 5`r`n"
$MissingUrl = ([Uri](Join-Path $Base 'installers\does-not-exist.ps1')).AbsoluteUri
$UnexpectedUrl = New-InstallerFixture 'unexpected' $StateProbe.Replace('{TOOL}', 'unexpected')
$SystemPath = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
$script:Serial = 0
# install.ps1 environment: test mode, empty registry Path fixtures, Bun reachable through the current Path unless $Vars says otherwise.
function New-Vars([hashtable]$Vars = @{}) {
  $script:Serial++
  $all = @{
    SystemRoot = $env:SystemRoot; windir = $env:windir; ComSpec = $env:ComSpec; PATHEXT = '.COM;.EXE;.BAT;.CMD'; USERNAME = $env:USERNAME
    TEMP = $Temp; TMP = $Temp; USERPROFILE = $HomeDir; LOCALAPPDATA = (Join-Path $HomeDir 'AppData\Local'); APPDATA = (Join-Path $HomeDir 'AppData\Roaming')
    Path = "$SystemPath;$BunDir"
    TERMWEAVE_INSTALL_TEST_MODE = '1'; TERMWEAVE_INSTALL_TEST_MACHINE_PATH = ''; TERMWEAVE_INSTALL_TEST_USER_PATH = ''
    TERMWEAVE_INSTALL_TEST_MUTEX_SUFFIX = $Suffix; TERMWEAVE_INSTALL_TEST_MUTEX_WAIT_MS = '30000'
    TERMWEAVE_INSTALL_TEST_BUN_INSTALLER_URL = $UnexpectedUrl; TERMWEAVE_INSTALL_TEST_HERDR_INSTALLER_URL = $UnexpectedUrl
    TW_TEST_RECORD = (Join-Path $Records "run-$($script:Serial).jsonl"); TW_FIXTURE_ROOT = $Base; TW_REAL_BUN = $RealBun
  }
  foreach ($name in $Vars.Keys) { $all[$name] = $Vars[$name] }
  return $all
}
function Read-InstallerLog { return @(Read-Records $InstallerLog) }
function Clear-InstallerLog { if ([IO.File]::Exists($InstallerLog)) { [IO.File]::Delete($InstallerLog) } }
$HolderScript = Join-Path $Base 'holder.ps1'
[IO.File]::WriteAllText($HolderScript, @'
param([string]$Name, [int]$HoldMs, [string]$Mode, [string]$Ready)
$ErrorActionPreference = 'Stop'
$mutex = New-Object System.Threading.Mutex($false, $Name)
$null = $mutex.WaitOne()
[IO.File]::WriteAllText($Ready, 'held')
Start-Sleep -Milliseconds $HoldMs
[IO.File]::WriteAllText($Ready + '.released', [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
if ($Mode -eq 'release') { $mutex.ReleaseMutex() }
exit 0
'@)
# Another holder of the install mutex (a running install.ps1). Abandon mode exits while holding it. A holder that does not get
# ready (or exits) is stopped before the throw, so it cannot take the mutex later and hold it into the next cases.
function Start-Holder([int]$HoldMs, [string]$Mode = 'release') {
  $ready = Join-Path $Markers ('holder-' + [guid]::NewGuid().ToString('N') + '.ready')
  $holder = [pscustomobject]@{ Run = (Start-PowerShell @('-File', $HolderScript, '-Name', $MutexName, '-HoldMs', [string]$HoldMs, '-Mode', $Mode, '-Ready', $ready) (New-Vars)); Released = "$ready.released" }
  try {
    Wait-Until 'the mutex holder to signal ready' { [IO.File]::Exists($ready) -or $holder.Run.Process.HasExited } $StartupMs
    if ($holder.Run.Process.HasExited) { throw "holder exited early: $($holder.Run.Err.Result)" }
  } catch { $failure = $_; try { Stop-Holder $holder } catch { throw "$($failure.Exception.Message); $($_.Exception.Message)" }; throw $failure }
  return $holder
}
# Still holding: the holder neither ended nor reached its release.
function Test-Held($Holder) { -not $Holder.Run.Process.HasExited -and -not [IO.File]::Exists($Holder.Released) }
function Stop-Holder($Holder) { Stop-Run $Holder.Run.Process; Assert-MutexFree 'after its holder was stopped' }
# Every file (with its size) and directory under $Roots, marked `written` when its write time is at or after $Since: a directory
# counts as written when an entry was created or deleted in it, even if that entry is gone again. Plus HKCU\Environment.
# Writes of powershell.exe itself are left out: its startup cache under LOCALAPPDATA and the policy probe file it creates and
# deletes in TEMP (so TEMP's own write time). Files in TEMP are still compared.
$HostWrites = @((Join-Path $HomeDir 'AppData\Local\Microsoft\Windows\PowerShell'))
function Get-Snapshot([string[]]$Roots, [long]$Since) {
  $lines = New-Object 'System.Collections.Generic.List[string]'
  $mark = { param($item) if ($item.LastWriteTimeUtc.Ticks -ge $Since) { 'written' } else { 'old' } }
  foreach ($root in $Roots) {
    if (-not (Test-Path -LiteralPath $root)) { $lines.Add("$root|absent"); continue }
    $item = Get-Item -LiteralPath $root -Force
    $lines.Add("$($item.FullName)|dir|$(if ($item.FullName -ne $Temp) { & $mark $item })")
    foreach ($entry in @(Get-ChildItem -LiteralPath $root -Recurse -Force)) {
      if (@($HostWrites | Where-Object { $entry.FullName.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { continue }
      $size = if ($entry -is [IO.FileInfo]) { $entry.Length } else { 'dir' }
      $lines.Add("$($entry.FullName)|$size|$(& $mark $entry)")
    }
  }
  # HKCU\Environment, read only: install.ps1 must never write the registry.
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
  try { foreach ($name in @($key.GetValueNames() | Sort-Object)) { $lines.Add("HKCU\Environment\$name=" + $key.GetValue($name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) } } finally { $key.Close() }
  return (@($lines | Sort-Object) -join "`n")
}
function Get-FreePort { $listener = New-Object System.Net.Sockets.TcpListener ([Net.IPAddress]::Loopback), 0; $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop(); return $port }

# ---- cases ------------------------------------------------------------------------
try {
  Test-Case 'install.ps1 is ASCII only, without a byte order mark' {
    $bytes = [IO.File]::ReadAllBytes($Installer)
    $bad = @(for ($i = 0; $i -lt $bytes.Length; $i++) { if ($bytes[$i] -gt 0x7F) { $i } })
    Assert-Equal 0 $bad.Count "non-ASCII bytes at offsets $($bad -join ',')"
  }

  Test-Case 'install.ps1 and this test parse under Windows PowerShell 5.1' {
    Assert-Equal 5 $PSVersionTable.PSVersion.Major 'the suite must run on Windows PowerShell 5.1'
    foreach ($file in @($Installer, $PSCommandPath)) {
      $tokens = $null; $errors = $null
      $null = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
      Assert-Equal 0 @($errors).Count "parse errors in ${file}: $(@($errors) -join '; ')"
    }
    # install.ps1's own code (the official installer child is a string literal, not part of this AST).
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$errors)
    $commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() } | Where-Object { $_ })
    $forbidden = @($commands | Where-Object { $_ -match '^(?i)(Invoke-Expression|iex|Start-Process|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-Item|New-Item|Set-Content|Add-Content|Out-File|Remove-Item|Set-ExecutionPolicy)$' })
    Assert-Equal '' ($forbidden -join ',') 'no string evaluation, elevation, file or registry writes in install.ps1 itself'
    $members = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true) | ForEach-Object { $_.Member.Extent.Text })
    $writes = @($members | Where-Object { $_ -match '^(?i)(SetValue|SetEnvironmentVariable|CreateSubKey|DeleteValue|DeleteSubKey|WriteAllText|WriteAllBytes|AppendAllText|Create|CreateDirectory|Delete|Kill)$' })
    Assert-Equal '' ($writes -join ',') 'no registry, environment or file writes and no kill through .NET calls'
    Assert-True (([IO.File]::ReadAllText($Installer)) -notmatch "'-ExecutionPolicy'") 'the installer child gets no -ExecutionPolicy'
  }

  Test-Case 'invalid arguments and ports exit 1 before TS runs and before the mutex is taken' {
    $holder = Start-Holder 120000
    try {
      $cases = @(@('--bogus'), @('check'), @('-port', '80'), @('--port'), @('--dir'), @('--dir', ''), @('--port', '0'), @('--port', '65536'), @('--port', '12a'), @('--port', '-1'), @('--port', ' 80'), @('--port', '99999999999'), @('--check', '--port', 'abc'), @('--yes', '--dir'))
      foreach ($argv in $cases) {
        $result = Invoke-Installer $argv (New-Vars)
        Assert-Equal 1 $result.Code "exit code for $($argv -join ' ')"
        Assert-Contains $result.Err 'Usage: powershell -NoProfile -File install.ps1' "usage for $($argv -join ' ')"
        Assert-Equal 0 $result.Records.Count "TS must not run for $($argv -join ' ')"
        Assert-True (-not $result.Err.Contains('wait  ')) "no mutex wait for $($argv -join ' ')"
      }
      Assert-Contains (Invoke-Installer @('--port', '0') (New-Vars)).Err 'Invalid port: 0' 'invalid port message'
      Assert-Contains (Invoke-Installer @('--bogus') (New-Vars)).Err 'Unknown option: --bogus' 'unknown option message'
      $help = Invoke-Installer @('--help') (New-Vars)
      Assert-Equal 0 $help.Code '--help exit code'
      Assert-Contains $help.Out '--check     verify prerequisites' '--help prints usage'
    } finally { Stop-Holder $holder }
  }

  Test-Case 'valid arguments reach TS as one exact argv array, never re-evaluated' {
    $odd = Join-Path $Work 'odd dir; $(Set-Content pwned x) & ''q'' %Path% `$x\'
    $result = Invoke-Installer @('--no-start', '--dir', $odd, '--port', '8123') (New-Vars)
    Assert-Equal 0 $result.Code "exit code; stderr: $($result.Err)"
    Assert-Equal 1 $result.Records.Count 'install only with --no-start'
    Assert-Equal "install|--dir|$odd|--port|8123" (Get-Argv $result.Records[0]) 'argv'
    Assert-Equal $Work $result.Records[0].cwd 'TS runs in the caller''s directory (relative --dir)'
    Assert-Contains $result.Out 'ok    skipped start (--no-start)' '--no-start note'
    Assert-Equal 0 @(Get-ChildItem -LiteralPath $Base -Recurse -Filter 'pwned*').Count 'nothing was evaluated'
    $plain = Invoke-Installer @() (New-Vars)
    Assert-Equal 0 $plain.Code 'default run'
    Assert-Equal 'install;start' (@($plain.Records | ForEach-Object { Get-Argv $_ }) -join ';') 'install then start, no --dir/--port added (TS applies TERMWEAVE_INSTALL_DIR/PORT)'
    $stop = Invoke-Installer @('--stop', '--yes', '--dir', 'rel\dir') (New-Vars)
    Assert-Equal 0 $stop.Code 'stop'
    Assert-Equal 'stop|--dir|rel\dir' (@($stop.Records | ForEach-Object { Get-Argv $_ }) -join ';') '--stop runs stop only'
    Assert-Equal 0 @(Read-InstallerLog).Count '--stop never runs an installer'
  }

  Test-Case 'exit codes pass through from TS; a failed install skips start' {
    foreach ($code in @(0, 1, 2)) {
      $result = Invoke-Installer @('--check') (New-Vars @{ TW_TEST_EXIT_CHECK = [string]$code })
      Assert-Equal $code $result.Code "check exit $code"
      Assert-Equal 'check' (@($result.Records | ForEach-Object { Get-Argv $_ }) -join ';') 'check only'
    }
    foreach ($code in @(1, 2)) {
      $install = Invoke-Installer @() (New-Vars @{ TW_TEST_EXIT_INSTALL = [string]$code })
      Assert-Equal $code $install.Code "install exit $code"
      Assert-Equal 'install' (@($install.Records | ForEach-Object { Get-Argv $_ }) -join ';') 'no start after a failed install'
    }
    $start = Invoke-Installer @() (New-Vars @{ TW_TEST_EXIT_START = '1' })
    Assert-Equal 1 $start.Code 'start failure (herdr not ready)'
    Assert-Contains $start.Err "the TermWeave server keeps running: start herdr, then run: powershell -NoProfile -File `"$FixtureInstaller`" --check" 'guidance after a failed start'
    Assert-True (-not $start.Err.Contains('--dir')) 'without --dir the guidance checks the default directory'
    # A bare --check would inspect the default directory: the guidance names the install the run was given.
    $dir = Join-Path $Work 'my install'
    $startDir = Invoke-Installer @('--dir', $dir) (New-Vars @{ TW_TEST_EXIT_START = '1' })
    Assert-Equal 1 $startDir.Code 'start failure with --dir'
    Assert-Equal "install|--dir|$dir;start|--dir|$dir" (@($startDir.Records | ForEach-Object { Get-Argv $_ }) -join ';') 'install and start got the --dir'
    Assert-Contains $startDir.Err "start herdr, then run: powershell -NoProfile -File `"$FixtureInstaller`" --check --dir `"$dir`"" 'guidance after a failed start keeps the --dir'
    Assert-Equal 3 (Invoke-Installer @('--stop') (New-Vars @{ TW_TEST_EXIT_STOP = '3' })).Code 'stop exit code'
  }

  Test-Case 'without Bun, --check exits 2 from PowerShell itself; changing calls exit 2 without --yes' {
    $noBun = @{ Path = $SystemPath }
    foreach ($argv in @(@('--check'), @('--check', '--yes'), @(), @('--stop'), @('--no-start'))) {
      $result = Invoke-Installer $argv (New-Vars $noBun)
      Assert-Equal 2 $result.Code "exit code for '$($argv -join ' ')'"
      Assert-Contains $result.Err 'MISS  bun not found' 'missing Bun reported'
      Assert-Contains $result.Err 'irm bun.sh/install.ps1 | iex' 'fix command'
      Assert-Equal 0 $result.Records.Count 'TS never runs'
    }
    Assert-Equal 0 @(Read-InstallerLog).Count 'no installer without --yes, and none for --check --yes'
  }

  Test-Case '--check --yes runs only check' {
    $result = Invoke-Installer @('--check', '--yes', '--no-start', '--stop') (New-Vars)
    Assert-Equal 0 $result.Code 'exit code'
    Assert-Equal 'check' (@($result.Records | ForEach-Object { Get-Argv $_ }) -join ';') 'records'
    Assert-Contains $result.Out 'note  --check changes nothing' 'ignored options note'
    Assert-Equal 0 @(Read-InstallerLog).Count 'no installer ran'
  }

  Test-Case '--check writes nothing and takes no mutex (stand-in TS and the real TS entry)' {
    $parent = Join-Path $Base 'install-parent'
    $owned = Join-Path $parent 'owned'
    $null = [IO.Directory]::CreateDirectory($owned)
    [IO.File]::WriteAllText((Join-Path $owned '.termweave-owned.json'), '{}')
    $roots = @($HomeDir, $Temp, $Work, $Src, $parent)
    # Bun's runtime transpiler cache (under USERPROFILE\.bun) is Bun's own, not a lifecycle write: off for this case.
    $toolVars = @{ Path = "$SystemPath;$BunDir;$GitDir;$(Join-Path $Tools 'herdr')"; BUN_RUNTIME_TRANSPILER_CACHE_PATH = '0' }
    # Held far longer than any startup (and than the 30 s test wait budget): a check that waited for the mutex could only run TS
    # after the release, or fail without TS; one that finishes TS while the mutex is still held never waited, however slow the host.
    $holder = Start-Holder 900000
    try {
      Start-Sleep -Milliseconds 200
      $since = [DateTime]::UtcNow.Ticks
      $before = Get-Snapshot $roots $since
      $stand = Invoke-Installer @('--check', '--yes', '--dir', $owned) (New-Vars @{ TW_TEST_EXIT_CHECK = '1'; BUN_RUNTIME_TRANSPILER_CACHE_PATH = '0' })
      Assert-Equal 1 $stand.Code 'stand-in check exit code'
      Assert-Equal "check|--dir|$owned" (Get-Argv $stand.Records[0]) 'stand-in argv'
      Assert-True ((Test-Held $holder) -and -not $stand.Err.Contains('wait  ')) "check must finish while the mutex is held, without waiting for it ($($stand.Ms) ms)"
      # The real install.ps1 and scripts/install-lifecycle.ts: git, bun and a herdr stand-in on Path; installed, nothing running.
      $port = Get-FreePort
      $real = Invoke-Installer @('--check', '--dir', $owned, '--port', [string]$port) (New-Vars $toolVars) $Installer
      Assert-Equal 1 $real.Code "real check exit code; out: $($real.Out) err: $($real.Err)"
      Assert-Contains $real.Out "ok    installed at $owned" 'real check judged the install'
      Assert-Contains $real.Err "MISS  no server answers http://127.0.0.1:$port/api/health" 'real check probed the given port'
      Assert-True ((Test-Held $holder) -and -not $real.Err.Contains('wait  ')) "real check must finish while the mutex is held, without waiting for it ($($real.Ms) ms)"
      $absent = Invoke-Installer @('--check', '--dir', (Join-Path $parent 'never\created')) (New-Vars $toolVars) $Installer
      Assert-Equal 1 $absent.Code 'real check of a missing install'
      $after = Get-Snapshot $roots $since
      Assert-True ($before -ceq $after) "check changed files or the registry:`n$(@(Compare-Object ($before -split "`n") ($after -split "`n") | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" }) -join "`n")"
    } finally { Stop-Holder $holder }
  }

  Test-Case 'changing calls are serialized by the per-user Global mutex' {
    $first = Start-PowerShell @('-File', $FixtureInstaller, '--no-start') (New-Vars @{ TW_TEST_HOLD_INSTALL = '3000' })
    Wait-Until 'the first install to reach TS' { @(Read-Records $first.Record).Count -gt 0 -or $first.Process.HasExited } $StartupMs
    $second = Invoke-Installer @('--no-start') (New-Vars)
    $firstResult = Complete-PowerShell $first
    Assert-Equal 0 $firstResult.Code "first run: $($firstResult.Err)"
    Assert-Equal 0 $second.Code "second run: $($second.Err)"
    Assert-Contains $second.Err "wait  another install.ps1 run of this Windows user holds the install mutex $MutexName" 'the second run waited on the SID-named mutex'
    Assert-True ($second.Records[0].at -ge $firstResult.Records[0].at + 2900) "the second install started $($second.Records[0].at - $firstResult.Records[0].at) ms after the first, inside its 3000 ms hold"
    # A holder that does not let go within the wait budget: the run fails and TS never runs.
    $holder = Start-Holder 60000
    try {
      $blocked = Invoke-Installer @('--no-start') (New-Vars @{ TERMWEAVE_INSTALL_TEST_MUTEX_WAIT_MS = '1500' })
      Assert-Equal 1 $blocked.Code "blocked exit code: $($blocked.Err)"
      Assert-Contains $blocked.Err "still holds the install mutex $MutexName after 1.5 s" 'blocked message'
      Assert-Equal 0 $blocked.Records.Count 'TS never ran while blocked'
      $blockedStop = Invoke-Installer @('--stop') (New-Vars @{ TERMWEAVE_INSTALL_TEST_MUTEX_WAIT_MS = '1500' })
      Assert-Equal 1 $blockedStop.Code '--stop takes the same mutex'
    } finally { Stop-Holder $holder }
    # A release in the middle of the wait lets it through after the release.
    $holder = Start-Holder 3000
    try {
      $waited = Invoke-Installer @('--no-start') (New-Vars)
      Assert-Equal 0 $waited.Code 'waited exit code'
      $released = [long][IO.File]::ReadAllText($holder.Released)
      Assert-True ($waited.Records[0].at -ge $released) 'TS ran only after the holder released the mutex'
    } finally { Stop-Holder $holder }
  }

  Test-Case 'an abandoned mutex is taken over through the OS result and reported' {
    $holder = Start-Holder 3000 'abandon'
    try {
      $result = Invoke-Installer @('--no-start') (New-Vars)
      Assert-Equal 0 $result.Code "exit code: $($result.Err)"
      Assert-Contains $result.Err "note  a previous install.ps1 run ended without releasing the install mutex $MutexName (abandoned); continuing" 'abandoned note'
      Assert-True ($result.Records[0].at -ge [long][IO.File]::ReadAllText($holder.Released)) 'TS ran only after the holder ended'
      $next = Invoke-Installer @('--no-start') (New-Vars)
      Assert-True ($next.Code -eq 0 -and -not $next.Err.Contains('abandoned') -and -not $next.Err.Contains('wait  ')) 'the abandoned mutex was released in finally'
    } finally { Stop-Holder $holder }
  }

  Test-Case '--yes installer children: failure and download failure are 1, success re-reads Path, state is isolated' {
    $noBun = @{ Path = $SystemPath }
    Clear-InstallerLog
    $failed = Invoke-Installer @('--yes') (New-Vars ($noBun + @{ TERMWEAVE_INSTALL_TEST_BUN_INSTALLER_URL = $FailUrl }))
    Assert-Equal 1 $failed.Code 'installer failure'
    Assert-Contains $failed.Err 'FAIL  the official Bun installer failed (exit 5' 'failure report'
    Assert-Contains $failed.Out 'fixture installer failing' 'installer output is shown'
    Assert-Equal 0 $failed.Records.Count 'no TS after a failed installer'
    Assert-Equal 0 @(Read-InstallerLog).Count 'herdr installer not run after the Bun installer failed'
    $download = Invoke-Installer @('--yes') (New-Vars ($noBun + @{ TERMWEAVE_INSTALL_TEST_BUN_INSTALLER_URL = $MissingUrl }))
    Assert-Equal 1 $download.Code 'download failure'
    Assert-Contains $download.Err 'FAIL  download of' 'download failure detail'
    Assert-Contains $download.Err 'FAIL  Bun installer download failed (network, proxy, TLS or a web filter' 'download failure category'
    $remote = Invoke-Installer @('--yes') (New-Vars ($noBun + @{ TERMWEAVE_INSTALL_TEST_BUN_INSTALLER_URL = 'https://example.invalid/install.ps1' }))
    Assert-Equal 1 $remote.Code 'a remote override is refused'
    Assert-Contains $remote.Err 'must be a local file: URI' 'remote override message'
    # Success: the Bun fixture links bun.exe into a directory that only the (fixture) User registry Path names, with an
    # unexpanded variable. herdr is missing too, so its installer runs next.
    Clear-InstallerLog
    $ok = Invoke-Installer @('--yes', '--no-start') (New-Vars ($noBun + @{ TERMWEAVE_INSTALL_TEST_BUN_INSTALLER_URL = $BunOkUrl; TERMWEAVE_INSTALL_TEST_HERDR_INSTALLER_URL = $HerdrOkUrl; TERMWEAVE_INSTALL_TEST_USER_PATH = '%TW_FIXTURE_ROOT%\installed\bun\bin' }))
    Assert-Equal 0 $ok.Code "success exit code: $($ok.Err)"
    $log = Read-InstallerLog
    Assert-Equal 'bun;herdr' (@($log | ForEach-Object { $_.tool }) -join ';') 'Bun installer, then herdr installer'
    foreach ($entry in $log) {
      Assert-True $entry.tls12 "$($entry.tool): TLS 1.2 enabled in the child"
      Assert-True (-not $entry.strict) "$($entry.tool): StrictMode off in the child"
      Assert-Equal 'Continue' $entry.eap "$($entry.tool): the child's own ErrorActionPreference"
      Assert-Equal '' $entry.policy "$($entry.tool): no inherited execution-policy bypass"
    }
    Assert-Equal 'install' (@($ok.Records | ForEach-Object { Get-Argv $_ }) -join ';') 'TS ran after the installers'
    Assert-True (@($ok.Records[0].path -split ';') -contains (Join-Path $Base 'installed\bun\bin')) 'the expanded registry Path reached TS'
    # Both tools present: --yes runs no installer.
    Clear-InstallerLog
    $present = Invoke-Installer @('--yes', '--no-start') (New-Vars @{ Path = "$SystemPath;$BunDir;$(Join-Path $Tools 'herdr')" })
    Assert-Equal 0 $present.Code 'present exit code'
    Assert-Equal 0 @(Read-InstallerLog).Count 'no installer when Bun and herdr are present'
  }

  Test-Case 'Path: expanded Machine/User registry fixture merged after the current Path, de-duplicated, one Path key' {
    $current = "$env:SystemRoot\System32;$BunDir\;C:\TwDup;c:\twdup\;;  C:\TwSpaced  ;C:\TwDup"
    $vars = New-Vars @{ Path = $current; TERMWEAVE_INSTALL_TEST_MACHINE_PATH = '%SystemRoot%\System32;C:\TwMachine;C:\TWDUP;'; TERMWEAVE_INSTALL_TEST_USER_PATH = "%TW_FIXTURE_ROOT%\user1;C:\TwMachine\;$BunDir" }
    $result = Invoke-Installer @('--check') $vars
    Assert-Equal 0 $result.Code "exit code: $($result.Err)"
    Assert-Equal 'Path' (@($result.Records[0].pathKeys) -join ',') 'exactly one Path key reaches TS'
    Assert-Equal "$env:SystemRoot\System32;$BunDir\;C:\TwDup;C:\TwSpaced;C:\TwMachine;$Base\user1" $result.Records[0].path 'merged Path'
    # Bun reachable only through the User registry fixture: the lookup uses the merged Path.
    $viaUser = Invoke-Installer @('--check') (New-Vars @{ Path = $SystemPath; TERMWEAVE_INSTALL_TEST_USER_PATH = $BunDir })
    Assert-Equal 0 $viaUser.Code "bun found through the registry Path: $($viaUser.Err)"
    Assert-Equal "$SystemPath;$BunDir" $viaUser.Records[0].path 'registry entry appended'
  }

  Test-Case 'TERMWEAVE_INSTALL_TEST_* is inert without TERMWEAVE_INSTALL_TEST_MODE=1 (read-only --check)' {
    # Outside test mode install.ps1 reads the real Machine/User Path (read only); --check never takes the mutex or runs an installer.
    $vars = New-Vars @{ TERMWEAVE_INSTALL_TEST_MODE = '0'; TERMWEAVE_INSTALL_TEST_USER_PATH = 'C:\TwFixtureMustNotAppear'; TERMWEAVE_INSTALL_TEST_MACHINE_PATH = 'C:\TwFixtureMustNotAppear2' }
    $result = Invoke-Installer @('--check') $vars
    Assert-Equal 0 $result.Code "exit code: $($result.Err)"
    Assert-True (-not $result.Records[0].path.Contains('TwFixtureMustNotAppear')) 'the fixture Path variables are ignored'
    Assert-True (-not $result.Err.Contains('test mode')) 'no test-mode override is active'
  }

  Test-Case 'irm | iex use is refused with the run-as-a-file instruction' {
    $quoted = $Installer.Replace("'", "''")
    $result = Complete-PowerShell (Start-PowerShell @('-Command', "Invoke-Expression ([IO.File]::ReadAllText('$quoted'))") (New-Vars))
    Assert-Equal 1 $result.Code "exit code: $($result.Err)"
    Assert-Contains $result.Err 'FAIL  run install.ps1 as a file from a cloned TermWeave source checkout' 'message'
  }
} finally {
  foreach ($process in $script:Started) { try { if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(10000) } } catch { } }
  $escaped = $Base.Replace('\', '\\').Replace("'", "''")
  $left = @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%$escaped%'" -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID })
  if ($left.Count -gt 0) { $script:Failed++; Write-Host "FAIL  processes left behind: $(@($left | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }) -join '; ')" }
  else { Write-Host 'ok    no process left behind (CIM count 0)' }
  Remove-Item -LiteralPath $Base -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "$($script:Passed) passed, $($script:Failed) failed"
if ($script:Failed -gt 0) { exit 1 }
exit 0
