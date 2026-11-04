# TermWeave bootstrap for native Windows (Windows PowerShell 5.1 or later). ASCII only.
#
#   powershell -NoProfile -File install.ps1            install (or reuse) and start TermWeave
#   powershell -NoProfile -File install.ps1 --check    verify only; changes nothing
#   powershell -NoProfile -File install.ps1 --yes      also allow the official Bun and herdr installers
#   powershell -NoProfile -File install.ps1 --stop     stop the installed server
#
# Run it as a file from a cloned TermWeave source checkout; it is not an `irm | iex` script. The lifecycle logic lives in
# scripts/install-lifecycle.ts. This file only finds Bun, refreshes Path from the registry (read only, never written), runs the
# official installers on --yes, serializes changing calls per Windows user and passes the TS exit code through.
# Exit codes: 0 ok, 2 missing prerequisite, 1 any other failure.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Usage = @'
Usage: powershell -NoProfile -File install.ps1 [--check] [--yes] [--no-start] [--stop] [--dir PATH] [--port N]
  --check     verify prerequisites, install and health; change nothing (every other option except --dir/--port is ignored)
  --yes       allow the official Bun and herdr installers when they are missing
  --no-start  install and build, but do not start the server
  --stop      stop the installed server (port: the recorded one; --port must match it)
  --dir PATH  install directory (default: $env:TERMWEAVE_INSTALL_DIR, else %LOCALAPPDATA%\termweave-owned)
  --port N    local port for a new start (default: $env:PORT, else 7317; a running instance keeps its recorded port)
'@
$SourceRoot = $PSScriptRoot
$ScriptPath = $PSCommandPath
# The recovery command the failure hints print. Invoke-Install appends --dir when one was given: a bare --check inspects the default directory.
$CheckCommand = "powershell -NoProfile -File `"$ScriptPath`" --check"
$OfficialBunInstaller = 'https://bun.sh/install.ps1'
$OfficialHerdrInstaller = 'https://herdr.dev/install.ps1'
# Mutating calls wait this long for another install.ps1 run of the same Windows user before failing.
$MutexBudgetMs = 15 * 60 * 1000
# TERMWEAVE_INSTALL_TEST_* settings are honoured only with TERMWEAVE_INSTALL_TEST_MODE=1 (scripts/windows-install.test.ps1). In
# test mode the real registry is never read, installer overrides must be local file: URIs, and every override is announced.
$TestMode = [Environment]::GetEnvironmentVariable('TERMWEAVE_INSTALL_TEST_MODE', 'Process') -eq '1'

function Write-Line([string]$Text) { [Console]::Out.WriteLine($Text) }
function Write-ErrLine([string]$Text) { [Console]::Error.WriteLine($Text) }
function Get-TestSetting([string]$Name) {
  if (-not $TestMode) { return $null }
  $value = [Environment]::GetEnvironmentVariable('TERMWEAVE_INSTALL_TEST_' + $Name, 'Process')
  if ([string]::IsNullOrEmpty($value)) { return $null }
  return $value
}
function Get-ErrorText($ErrorRecord) {
  $exception = $ErrorRecord.Exception
  while ($exception -is [System.Management.Automation.MethodInvocationException] -and $null -ne $exception.InnerException) { $exception = $exception.InnerException }
  return $exception.Message
}

# ---- arguments ---------------------------------------------------------------
function Test-Port([string]$Value) {
  $number = 0
  return ($Value -match '^[0-9]+$') -and [int]::TryParse($Value, [ref]$number) -and $number -ge 1 -and $number -le 65535
}
function ConvertFrom-InstallArguments([object[]]$Argv) {
  $options = @{ Check = $false; Yes = $false; NoStart = $false; Stop = $false; Dir = $null; Port = $null; Help = $false; Error = $null }
  for ($i = 0; $i -lt $Argv.Count; $i++) {
    $arg = [string]$Argv[$i]
    if ($arg -ceq '--check') { $options.Check = $true }
    elseif ($arg -ceq '--yes') { $options.Yes = $true }
    elseif ($arg -ceq '--no-start') { $options.NoStart = $true }
    elseif ($arg -ceq '--stop') { $options.Stop = $true }
    elseif ($arg -ceq '-h' -or $arg -ceq '--help') { $options.Help = $true }
    elseif ($arg -ceq '--dir' -or $arg -ceq '--port') {
      if ($i + 1 -ge $Argv.Count -or [string]::IsNullOrEmpty([string]$Argv[$i + 1])) { $options.Error = "$arg needs a value"; return $options }
      $i++
      if ($arg -ceq '--dir') { $options.Dir = [string]$Argv[$i] } else { $options.Port = [string]$Argv[$i] }
    }
    else { $options.Error = "Unknown option: $arg"; return $options }
  }
  if ($null -ne $options.Port -and -not (Test-Port $options.Port)) { $options.Error = "Invalid port: $($options.Port)" }
  return $options
}

# ---- Path refresh (registry read only) ---------------------------------------
function Get-RegistryPath([string]$Scope) {
  if ($TestMode) {
    $raw = [Environment]::GetEnvironmentVariable("TERMWEAVE_INSTALL_TEST_$($Scope.ToUpperInvariant())_PATH", 'Process')
  } else {
    if ($Scope -eq 'Machine') { $hive = [Microsoft.Win32.Registry]::LocalMachine; $subKey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' }
    else { $hive = [Microsoft.Win32.Registry]::CurrentUser; $subKey = 'Environment' }
    try {
      $key = $hive.OpenSubKey($subKey, $false)
      if ($null -eq $key) { return '' }
      try { $raw = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $key.Close() }
    } catch {
      Write-ErrLine "note  cannot read the $Scope Path from the registry ($(Get-ErrorText $_)); using the current Path without it"
      return ''
    }
  }
  if ($null -eq $raw) { return '' }
  return [Environment]::ExpandEnvironmentVariables([string]$raw)
}
# Path lists joined in order, entries trimmed, empty ones dropped, duplicates (case-insensitive, trailing slash ignored) removed.
function Merge-PathValue([string[]]$Values) {
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' -ArgumentList ([StringComparer]::OrdinalIgnoreCase)
  $entries = New-Object 'System.Collections.Generic.List[string]'
  foreach ($value in $Values) {
    if ([string]::IsNullOrEmpty($value)) { continue }
    foreach ($entry in $value.Split(';')) {
      $trimmed = $entry.Trim()
      $id = $trimmed.Trim('"').TrimEnd('\', '/')
      if ($id.Length -eq 0 -or -not $seen.Add($id)) { continue }
      $entries.Add($trimmed)
    }
  }
  return ($entries -join ';')
}
# The current process Path first (it keeps this session's own order), then entries an installer added to the registry since.
function Get-SessionPath {
  return Merge-PathValue @([Environment]::GetEnvironmentVariable('Path', 'Process'), (Get-RegistryPath 'Machine'), (Get-RegistryPath 'User'))
}
# Same search order as scripts/lifecycle-env.ts findExecutable: official default directories, then Path. bun/herdr under
# \WindowsApps\ or \System32\ are Store aliases or stand-ins, never the real tool. Bun is run only as bun.exe so that its arguments
# reach it exactly (a .cmd shim would re-parse them through cmd.exe).
function Find-Tool([string]$Name, [string]$PathValue, [string[]]$Extensions) {
  $userProfile = [Environment]::GetEnvironmentVariable('USERPROFILE', 'Process')
  $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'Process')
  $dirs = New-Object 'System.Collections.Generic.List[string]'
  if ($Name -eq 'bun' -and $userProfile) { $dirs.Add((Join-Path $userProfile '.bun\bin')) }
  if ($Name -eq 'herdr') {
    if ($localAppData) { $dirs.Add((Join-Path $localAppData 'Programs\Herdr\bin')) }
    if ($userProfile) { $dirs.Add((Join-Path $userProfile '.herdr\packages\standalone\current')) }
  }
  foreach ($entry in $PathValue.Split(';')) { $dirs.Add($entry.Trim().Trim('"')) }
  foreach ($dir in $dirs) {
    if ([string]::IsNullOrEmpty($dir)) { continue }
    foreach ($extension in $Extensions) {
      try { if (-not [IO.Path]::IsPathRooted($dir)) { break }; $candidate = [IO.Path]::Combine($dir, $Name + $extension) } catch { break }
      if ($candidate -match '[\\/](WindowsApps|System32)[\\/]') { continue }
      if ([IO.File]::Exists($candidate)) { return $candidate }
    }
  }
  return $null
}
function Get-PathExtensions {
  $value = [Environment]::GetEnvironmentVariable('PATHEXT', 'Process')
  if ([string]::IsNullOrEmpty($value)) { $value = '.COM;.EXE;.BAT;.CMD' }
  return @($value.Split(';') | Where-Object { $_ })
}
function Write-MissingBun {
  Write-ErrLine 'MISS  bun not found (bun.exe in %USERPROFILE%\.bun\bin or on Path, the registry Path included). Fix: powershell -c "irm bun.sh/install.ps1 | iex"   (or rerun with --yes)'
  Write-ErrLine 'Missing prerequisites. Run the Fix command above, then rerun install.ps1. git and herdr are checked once Bun is available.'
}

# ---- child processes ---------------------------------------------------------
# One argv element as CommandLineToArgvW reads it back: no shell, no re-evaluation, backslashes before quotes doubled.
function ConvertTo-ArgumentText([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $text = New-Object System.Text.StringBuilder
  $null = $text.Append('"')
  $slashes = 0
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
# The child shares this console (Ctrl+C reaches it directly) and inherits this environment with $Set applied and $Remove dropped.
function Start-Child([string]$FileName, [string[]]$Arguments, [hashtable]$Set, [string[]]$Remove) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $FileName
  $info.Arguments = (@($Arguments | ForEach-Object { ConvertTo-ArgumentText $_ }) -join ' ')
  $info.UseShellExecute = $false
  $info.WorkingDirectory = (Get-Location -PSProvider FileSystem).ProviderPath
  foreach ($name in @($Remove) + @($Set.Keys)) { if ($name) { $info.EnvironmentVariables.Remove($name) } }
  foreach ($name in $Set.Keys) { $info.EnvironmentVariables[$name] = [string]$Set[$name] }
  return [System.Diagnostics.Process]::Start($info)
}
# Waits for the child. Ctrl+C reaches the child through the shared console and it runs its own graceful path: this script never
# kills it, waits for it to end, then reports the cancellation (the caller's finally releases the install mutex afterwards).
function Wait-Child([System.Diagnostics.Process]$Process, [string]$What) {
  $finished = $false
  try {
    while (-not $Process.WaitForExit(250)) { }
    $Process.WaitForExit()
    $finished = $true
    return $Process.ExitCode
  } finally {
    if (-not $finished) {
      Write-ErrLine "note  cancelled: waiting for $What to finish its own cleanup (nothing is killed)"
      $Process.WaitForExit()
      Write-ErrLine "FAIL  cancelled; $What exited with $($Process.ExitCode). Check the state with: $CheckCommand"
    }
  }
}
function Invoke-Lifecycle([string]$Bun, [string]$PathValue, [string[]]$Arguments) {
  $entry = Join-Path $SourceRoot 'scripts\install-lifecycle.ts'
  $process = Start-Child $Bun (@($entry) + $Arguments) @{ Path = $PathValue } @()
  return Wait-Child $process "bun scripts/install-lifecycle.ts $($Arguments[0])"
}

# ---- official installers (--yes only) ----------------------------------------
# Runs in its own powershell.exe -NoProfile: its StrictMode, ErrorActionPreference and `exit` cannot reach this script. TLS 1.2 is
# added for the download. Exit 3: download failed, 4: TLS 1.2 could not be enabled, other non-zero: the installer failed.
$ChildInstaller = @'
Set-StrictMode -Off
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$url = $env:TERMWEAVE_OFFICIAL_INSTALLER_URL
Remove-Item Env:\TERMWEAVE_OFFICIAL_INSTALLER_URL
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 }
catch { [Console]::Error.WriteLine('FAIL  cannot enable TLS 1.2 for the download: ' + $_.Exception.Message); exit 4 }
try { $script = Invoke-RestMethod -Uri $url -UseBasicParsing -ErrorAction Stop }
catch { [Console]::Error.WriteLine('FAIL  download of ' + $url + ' failed: ' + $_.Exception.Message); exit 3 }
if (-not ($script -is [string]) -or $script.Trim().Length -eq 0) { [Console]::Error.WriteLine('FAIL  ' + $url + ' did not return a PowerShell script'); exit 3 }
try { Invoke-Expression $script } catch { [Console]::Error.WriteLine('FAIL  installer error: ' + $_.Exception.Message); exit 1 }
exit 0
'@
function Get-InstallerUrl([string]$Name, [string]$Official) {
  $setting = $Name.ToUpperInvariant() + '_INSTALLER_URL'
  $override = Get-TestSetting $setting
  if ($null -eq $override) { return $Official }
  $uri = $null
  if (-not [Uri]::TryCreate($override, [UriKind]::Absolute, [ref]$uri) -or -not $uri.IsFile) { throw "TERMWEAVE_INSTALL_TEST_$setting must be a local file: URI" }
  Write-ErrLine "note  test mode: the official $Name installer is replaced by the local fixture $($uri.AbsoluteUri)"
  return $uri.AbsoluteUri
}
function Invoke-OfficialInstaller([string]$Name, [string]$Url) {
  Write-Line "Installing $Name with its official installer: irm $Url | iex   (separate powershell.exe -NoProfile)"
  $shell = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ChildInstaller))
  # The child gets the user's own execution policy: an inherited -ExecutionPolicy of this run is not passed on.
  try { $process = Start-Child $shell @('-NoProfile', '-EncodedCommand', $encoded) @{ TERMWEAVE_OFFICIAL_INSTALLER_URL = $Url } @('PSExecutionPolicyPreference') }
  catch { Write-ErrLine "FAIL  cannot start $shell for the $Name installer ($(Get-ErrorText $_)). A software restriction or AppLocker policy may block it."; return 1 }
  $code = Wait-Child $process "the $Name installer"
  if ($code -eq 0) { Write-Line "ok    the $Name installer finished"; return 0 }
  if ($code -eq 3) { Write-ErrLine "FAIL  $Name installer download failed (network, proxy, TLS or a web filter; see the line above). Nothing was installed." }
  elseif ($code -eq 4) { Write-ErrLine "FAIL  $Name installer: TLS 1.2 is unavailable in Windows PowerShell (system policy). Nothing was downloaded." }
  else { Write-ErrLine "FAIL  the official $Name installer failed (exit $code; its output is above). Causes it reports include curl.exe, proxy, network and execution or AppLocker policy failures." }
  Write-ErrLine "      Install $Name yourself with: irm $Url | iex   then rerun install.ps1"
  return 1
}

# ---- per-user install mutex ----------------------------------------------------
function Test-Abandoned([Exception]$Exception) {
  for ($e = $Exception; $null -ne $e; $e = $e.InnerException) { if ($e -is [System.Threading.AbandonedMutexException]) { return $true } }
  return $false
}
# One fixed mutex per Windows user SID, in the Global\ namespace so every terminal and every logon session (console, RDP, SSH) of
# that user meets on the same object; Local\ would split per session. Its DACL grants only this SID, and an existing object must
# be owned by this SID (or by Administrators, the owner an elevated window of the same user records), else it is refused.
function Enter-InstallMutex {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $name = 'Global\TermWeave.Install.' + $sid.Value
  $suffix = Get-TestSetting 'MUTEX_SUFFIX'
  if ($null -ne $suffix) { $name += '.' + $suffix }
  $budget = $MutexBudgetMs
  $testBudget = Get-TestSetting 'MUTEX_WAIT_MS'
  if ($null -ne $testBudget) { $budget = [int]$testBudget }
  $security = New-Object System.Security.AccessControl.MutexSecurity
  $security.AddAccessRule((New-Object System.Security.AccessControl.MutexAccessRule($sid, [System.Security.AccessControl.MutexRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)))
  $created = $false
  try { $mutex = New-Object System.Threading.Mutex($false, $name, [ref]$created, $security) }
  catch { Write-ErrLine "FAIL  cannot open the install mutex $name ($(Get-ErrorText $_)). Another account or an elevated window may hold it; close other install.ps1 windows and rerun."; return $null }
  try { $owner = $mutex.GetAccessControl().GetOwner([System.Security.Principal.SecurityIdentifier]).Value }
  catch { $mutex.Dispose(); Write-ErrLine "FAIL  cannot read the owner of the install mutex $name ($(Get-ErrorText $_))"; return $null }
  if ($owner -ne $sid.Value -and $owner -ne 'S-1-5-32-544') { $mutex.Dispose(); Write-ErrLine "FAIL  the install mutex $name belongs to $owner, not to this user; refused"; return $null }
  $deadline = [DateTime]::UtcNow.AddMilliseconds($budget)
  $acquired = $false
  $abandoned = $false
  $announced = $false
  while ($true) {
    try { $acquired = $mutex.WaitOne($(if ($announced) { 250 } else { 0 })) }
    catch { if (-not (Test-Abandoned $_.Exception)) { $mutex.Dispose(); throw }; $acquired = $true; $abandoned = $true }
    if ($acquired) { break }
    if (-not $announced) { Write-ErrLine "wait  another install.ps1 run of this Windows user holds the install mutex $name; waiting up to $([math]::Round($budget / 1000, 1)) s"; $announced = $true }
    if ([DateTime]::UtcNow -ge $deadline) {
      $mutex.Dispose()
      Write-ErrLine "FAIL  another install.ps1 run of this Windows user still holds the install mutex $name after $([math]::Round($budget / 1000, 1)) s. Let it finish, then rerun."
      return $null
    }
  }
  if ($abandoned) { Write-ErrLine "note  a previous install.ps1 run ended without releasing the install mutex $name (abandoned); continuing. scripts/install-lifecycle.ts judges the lifecycle state as usual." }
  return $mutex
}

# ---- main ----------------------------------------------------------------------
function Invoke-Changing($Options, [string[]]$Common) {
  $pathValue = Get-SessionPath
  $bun = Find-Tool 'bun' $pathValue @('.exe')
  if ($Options.Stop) {
    if (-not $bun) { Write-MissingBun; return 2 }
    return Invoke-Lifecycle $bun $pathValue (@('stop') + $Common)
  }
  if ($Options.Yes) {
    $ran = $false
    if (-not $bun) {
      $code = Invoke-OfficialInstaller 'Bun' (Get-InstallerUrl 'Bun' $OfficialBunInstaller)
      if ($code -ne 0) { return $code }
      $ran = $true
    }
    if (-not (Find-Tool 'herdr' $pathValue (Get-PathExtensions))) {
      $code = Invoke-OfficialInstaller 'herdr' (Get-InstallerUrl 'herdr' $OfficialHerdrInstaller)
      if ($code -ne 0) { return $code }
      $ran = $true
    }
    if ($ran) {
      $pathValue = Get-SessionPath
      $bun = Find-Tool 'bun' $pathValue @('.exe')
      if (-not $bun) { Write-ErrLine 'MISS  the Bun installer finished, but bun.exe is still not found in %USERPROFILE%\.bun\bin or on the registry Path.'; Write-MissingBun; return 2 }
    }
  }
  if (-not $bun) { Write-MissingBun; return 2 }
  $code = Invoke-Lifecycle $bun $pathValue (@('install') + $Common)
  if ($code -ne 0) { return $code }
  if ($Options.NoStart) { Write-Line "ok    skipped start (--no-start). Start later: powershell -NoProfile -File `"$ScriptPath`""; return 0 }
  $code = Invoke-Lifecycle $bun $pathValue (@('start') + $Common)
  if ($code -ne 0) { Write-ErrLine "note  see the lines above. When only herdr is not ready, the TermWeave server keeps running: start herdr, then run: $CheckCommand" }
  return $code
}
function Invoke-Install([object[]]$Argv) {
  $options = ConvertFrom-InstallArguments $Argv
  if ($null -ne $options.Error) { Write-ErrLine $options.Error; Write-ErrLine $Usage; return 1 }
  if ($options.Help) { Write-Line $Usage; return 0 }
  if ([string]::IsNullOrEmpty($SourceRoot) -or -not [IO.File]::Exists((Join-Path $SourceRoot 'scripts\install-lifecycle.ts'))) {
    Write-ErrLine 'FAIL  run install.ps1 as a file from a cloned TermWeave source checkout: powershell -NoProfile -File <checkout>\install.ps1 (it is not an irm | iex script)'
    return 1
  }
  $common = @()
  if ($null -ne $options.Dir) { $common += @('--dir', $options.Dir); $script:CheckCommand += " --dir `"$($options.Dir)`"" }
  if ($null -ne $options.Port) { $common += @('--port', $options.Port) }
  if ($options.Check) {
    # Read only: no download, mutex, lock, log, file or registry write. The registry is read for the Path refresh only.
    if ($options.Yes -or $options.Stop -or $options.NoStart) { Write-Line 'note  --check changes nothing: --yes, --stop and --no-start are ignored' }
    $pathValue = Get-SessionPath
    $bun = Find-Tool 'bun' $pathValue @('.exe')
    if (-not $bun) { Write-MissingBun; return 2 }
    return Invoke-Lifecycle $bun $pathValue (@('check') + $common)
  }
  # Order: this per-user mutex first, then the TS shared guard and work lock inside install-lifecycle.ts; never the reverse. This
  # script never creates or deletes the TS guard or lock.
  $mutex = Enter-InstallMutex
  if ($null -eq $mutex) { return 1 }
  try { return Invoke-Changing $options $common }
  finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
}

try { $exitCode = Invoke-Install $args }
catch { Write-ErrLine "FAIL  $(Get-ErrorText $_)"; $exitCode = 1 }
exit ([int]$exitCode)
