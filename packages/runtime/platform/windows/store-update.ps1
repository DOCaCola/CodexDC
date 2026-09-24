param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("check", "start")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[A-Za-z0-9_.-]+_[A-Za-z0-9]+$")]
  [string]$PackageFamily
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$managerType = [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager,Windows.ApplicationModel.Store.Preview.InstallControl,ContentType=WindowsRuntime]
$itemType = [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallItem,Windows.ApplicationModel.Store.Preview.InstallControl,ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object {
    $_.Name -eq "AsTask" -and
    $_.IsGenericMethodDefinition -and
    $_.GetGenericArguments().Count -eq 1 -and
    $_.GetParameters().Count -eq 1
  } |
  Select-Object -First 1

function Wait-StoreOperation($operation, [type]$resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  Write-Output -NoEnumerate $task.GetAwaiter().GetResult()
}

function Test-StoreItemFamily($items, [string]$packageFamily) {
  $listType = [System.Collections.Generic.IReadOnlyList``1].MakeGenericType($itemType)
  $collectionType = [System.Collections.Generic.IReadOnlyCollection``1].MakeGenericType($itemType)
  $count = $collectionType.GetProperty("Count").GetValue($items)
  for ($index = 0; $index -lt $count; $index++) {
    $item = $listType.GetProperty("Item").GetValue($items, @($index))
    $family = $itemType.GetProperty("PackageFamilyName").GetValue($item)
    if ([string]::Equals($family, $packageFamily, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

$manager = $managerType::new()

if ($Action -eq "check") {
  $listType = [System.Collections.Generic.IReadOnlyList``1].MakeGenericType($itemType)
  $updates = Wait-StoreOperation $manager.SearchForAllUpdatesAsync() $listType
  $available = Test-StoreItemFamily $updates $PackageFamily
  [pscustomobject]@{ available = $available } | ConvertTo-Json -Compress
  exit 0
}

$update = Wait-StoreOperation $manager.UpdateAppByPackageFamilyNameAsync($PackageFamily) $itemType
$queued = $null -ne $update
if (-not $queued) {
  $items = $managerType.GetProperty("AppInstallItems").GetValue($manager)
  $queued = Test-StoreItemFamily $items $PackageFamily
}
[pscustomobject]@{ queued = $queued } | ConvertTo-Json -Compress
