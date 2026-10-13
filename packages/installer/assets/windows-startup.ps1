param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9.-]+_[A-Za-z0-9]+$')]
  [string]$PackageFamily,

  [ValidateSet('query', 'disable')]
  [string]$Mode = 'query'
)

$ErrorActionPreference = 'Stop'
$packageName = $PackageFamily.Substring(0, $PackageFamily.LastIndexOf('_'))
$package = Get-AppxPackage -Name $packageName |
  Where-Object PackageFamilyName -eq $PackageFamily |
  Sort-Object Version -Descending |
  Select-Object -First 1
$tasks = @()
if ($package) {
  [xml]$manifest = Get-Content -LiteralPath (Join-Path $package.InstallLocation 'AppxManifest.xml')
  $root = Join-Path 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData' $PackageFamily
  foreach ($task in $manifest.SelectNodes("//*[local-name()='Extension' and @Category='windows.startupTask']/*[local-name()='StartupTask']")) {
    $taskId = $task.GetAttribute('TaskId')
    if ([string]::IsNullOrWhiteSpace($taskId) -or $taskId.IndexOfAny([char[]]'\/') -ge 0) {
      throw 'Invalid Windows startup task ID in the official package manifest.'
    }
    $path = Join-Path $root $taskId
    $defaultState = if ($task.GetAttribute('Enabled') -eq 'true') { 2 } else { 0 }
    $state = if (Test-Path -LiteralPath $path) { (Get-Item -LiteralPath $path).GetValue('State', $defaultState) } else { $defaultState }
    if ($state -notin @(0, 1, 2, 3, 4)) { throw "Unknown startup task state for ${taskId}: $state" }
    if ($Mode -eq 'disable' -and $state -eq 4) {
      throw "Official Codex startup task '$taskId' is enabled by policy. Disable it through your administrator before using CodexDC."
    }
    $changed = $false
    if ($Mode -eq 'disable' -and $state -eq 2) {
      # DisabledByUser persists across package updates. Do not alter policy states.
      if (!(Test-Path -LiteralPath $path)) { New-Item -Path $path -Force | Out-Null }
      New-ItemProperty -LiteralPath $path -Name State -PropertyType DWord -Value 1 -Force | Out-Null
      $state = (Get-Item -LiteralPath $path).GetValue('State')
      if ($state -ne 1) { throw "Could not disable official Codex startup task '$taskId'." }
      $changed = $true
    }
    $tasks += [pscustomobject]@{ taskId = $taskId; state = $state; changed = $changed }
  }
}
ConvertTo-Json -InputObject @($tasks) -Compress
