# claude-profiles.ps1: manage & switch Claude Code account profiles (native PowerShell).
#
# Dot-source this from your PowerShell profile ($PROFILE):
#   . "$(npm root -g)/ccrig/claude-profiles.ps1"
#
# A "profile" is an isolated CLAUDE_CONFIG_DIR (its own login, settings, history), so you can
# run multiple Claude accounts side by side. The default profile is ~/.claude; a named profile
# "<name>" lives in ~/.claude-<name>. The companion status line shows a badge for the active one.
#
# The PowerShell peer of claude-profiles.sh. Works in Windows PowerShell 5.1 and PowerShell 7+
# (Windows, macOS, Linux).

# Resolve home the SAME way Node's os.homedir() does (USERPROFILE on Windows), so this agrees with
# Claude Code + statusline.js. Windows PowerShell 5.1's $HOME is HOMEDRIVE+HOMEPATH, which on
# domain-joined machines can point at a mapped network drive and disagree with where `claude` lives.
function _Cc-Home {
  $h = [Environment]::GetFolderPath('UserProfile')
  if (-not $h) { $h = $env:USERPROFILE }
  if (-not $h) { $h = $HOME }
  return $h
}
# accept only the advertised charset (letters, digits, . _ -), no leading -/., no '..'. A deny-list
# would let through Windows-hostile names: a trailing dot/space aliases to another profile (so
# `remove "work."` would delete "work"), and ':' / wildcards are ADS / glob hazards.
function _Cc-ValidName([string]$Name) {
  if ([string]::IsNullOrEmpty($Name)) { return $false }
  if ($Name -match '\.\.') { return $false }
  if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { return $false }
  return $true
}
function _Cc-ProfileDir([string]$Name) {   # name -> dir
  $hd = _Cc-Home
  if ([string]::IsNullOrEmpty($Name) -or $Name -eq 'default') { return (Join-Path $hd '.claude') }
  return (Join-Path $hd ".claude-$Name")
}
function _Cc-ProfileName([string]$Dir) {    # dir -> name
  $leaf = Split-Path -Path $Dir -Leaf
  if ($leaf -eq '.claude') { return 'default' }
  if ($leaf -like '.claude-*') { return $leaf.Substring('.claude-'.Length) }
  return $leaf
}
function _Cc-Current { if ($env:CLAUDE_CONFIG_DIR) { return $env:CLAUDE_CONFIG_DIR } return (_Cc-ProfileDir 'default') }
# canonicalize a path (separators, case-insensitive compare) so the current-profile marker is reliable
function _Cc-Norm([string]$p) { if (-not $p) { return '' } try { return [IO.Path]::GetFullPath($p).TrimEnd('\', '/') } catch { return $p.TrimEnd('\', '/') } }

function claude-profile {
  # Plain (non-advanced) function: parse $args ourselves so `run <name> --flag` and `-h`/`--help`
  # pass through verbatim instead of being captured as PowerShell parameters.
  $tokens = @($args)
  $cmd = if ($tokens.Count -ge 1 -and $tokens[0]) { [string]$tokens[0] } else { 'list' }
  $name = if ($tokens.Count -ge 2) { [string]$tokens[1] } else { '' }
  $passthru = if ($tokens.Count -ge 3) { $tokens[2..($tokens.Count - 1)] } else { @() }

  $hd = _Cc-Home
  if (-not $hd) { Write-Host 'cannot determine your home directory (USERPROFILE / HOME are unset)'; return }

  switch -Regex ($cmd) {
    '^(list|ls)$' {
      $cur = _Cc-Norm (_Cc-Current)
      $dirs = @()
      $def = Join-Path $hd '.claude'
      if (Test-Path -LiteralPath $def -PathType Container) { $dirs += $def }
      # -Force is required to surface dot-directories on macOS/Linux (a leading '.' = Hidden there)
      $dirs += Get-ChildItem -LiteralPath $hd -Directory -Filter '.claude-*' -Force -ErrorAction SilentlyContinue |
        Sort-Object Name | ForEach-Object { $_.FullName }
      foreach ($d in $dirs) {
        $n = _Cc-ProfileName $d
        if ((_Cc-Norm $d) -ieq $cur) { Write-Host "  * $n" -ForegroundColor Green }
        else { Write-Host "    $n" }
      }
      break
    }
    '^(use|switch)$' {
      if (-not $name) { Write-Host 'usage: claude-profile use <name>'; break }
      if (-not (_Cc-ValidName $name)) { Write-Host "invalid profile name '$name' (letters, digits, . _ - only)"; break }
      $dir = _Cc-ProfileDir $name
      if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Write-Host "profile '$name' not found. create it:  claude-profile new $name"; break }
      $env:CLAUDE_CONFIG_DIR = $dir
      Write-Host "Claude profile -> $name   ($dir)" -ForegroundColor Green
      Write-Host "   run 'claude' to start it in this shell."
      break
    }
    '^run$' {
      if (-not $name) { Write-Host 'usage: claude-profile run <name> [claude args]'; break }
      if (-not (_Cc-ValidName $name)) { Write-Host "invalid profile name '$name' (letters, digits, . _ - only)"; break }
      $dir = _Cc-ProfileDir $name
      if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Write-Host "profile '$name' not found. create it:  claude-profile new $name"; break }
      if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host "'claude' was not found on PATH"; break }
      # set CLAUDE_CONFIG_DIR for this ONE launch only, then restore (mirrors `VAR=x cmd` in bash)
      $old = $env:CLAUDE_CONFIG_DIR
      $env:CLAUDE_CONFIG_DIR = $dir
      try { & claude @passthru }
      finally {
        if ($null -eq $old) { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
        else { $env:CLAUDE_CONFIG_DIR = $old }
      }
      break
    }
    '^(new|create)$' {
      if (-not $name) { Write-Host 'usage: claude-profile new <name>'; break }
      if (-not (_Cc-ValidName $name)) { Write-Host "invalid profile name '$name' (letters, digits, . _ - only)"; break }
      $dir = _Cc-ProfileDir $name
      if (Test-Path -LiteralPath $dir -PathType Container) { Write-Host "profile '$name' already exists ($dir)"; break }
      New-Item -ItemType Directory -LiteralPath $dir -Force | Out-Null
      Write-Host "created profile '$name'.  Start it:  claude-profile use $name; claude   (then /login)"
      break
    }
    '^(current|who)$' {
      $cur = _Cc-Current
      Write-Host ("{0}   ({1})" -f (_Cc-ProfileName $cur), $cur)
      break
    }
    '^(remove|rm)$' {
      if (-not $name) { Write-Host 'usage: claude-profile remove <name>'; break }
      if ($name -eq 'default') { Write-Host 'refusing to remove the default profile (~/.claude)'; break }
      if (-not (_Cc-ValidName $name)) { Write-Host "invalid profile name '$name' (letters, digits, . _ - only)"; break }
      $dir = _Cc-ProfileDir $name
      if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Write-Host "profile '$name' not found"; break }
      $ans = Read-Host "remove profile '$name' and ALL its data ($dir)? [y/N]"
      if ($ans -match '^[yY]') {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $hd (Join-Path '.claude-usage-ledger' ".claude-$name.json")) -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $dir) { Write-Host "could not fully remove '$name' (is claude still running?)" }
        else { Write-Host "removed '$name'" }
      } else { Write-Host 'cancelled' }
      break
    }
    '^(-h|--help|help)$' {
      Write-Host @'
claude-profile: manage Claude Code account profiles (isolated CLAUDE_CONFIG_DIR)

  claude-profile list                list profiles (* = current)
  claude-profile use <name>          switch this shell to a profile, then run `claude`
  claude-profile run <name> [args]   launch claude with a profile (one-off)
  claude-profile new <name>          create a new profile (then `claude` + /login)
  claude-profile current             show the active profile
  claude-profile remove <name>       delete a profile (asks first)

The default profile is ~/.claude; "<name>" lives in ~/.claude-<name>.
'@
      break
    }
    default { Write-Host "unknown command '$cmd': try: claude-profile help" }
  }
}
