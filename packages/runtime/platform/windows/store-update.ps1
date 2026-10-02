param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("check", "start", "status")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[A-Za-z0-9_.-]+_[A-Za-z0-9]+$")]
  [string]$PackageFamily
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$managerType = [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager,Windows.ApplicationModel.Store.Preview.InstallControl,ContentType=WindowsRuntime]
$itemType = [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallItem,Windows.ApplicationModel.Store.Preview.InstallControl,ContentType=WindowsRuntime]
$statusType = [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallStatus,Windows.ApplicationModel.Store.Preview.InstallControl,ContentType=WindowsRuntime]
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

function Get-StoreItemStatus($item) {
  $status = $itemType.GetMethod("GetCurrentStatus").Invoke($item, @())
  [pscustomobject]@{
    state = [string]$statusType.GetProperty("InstallState").GetValue($status)
    percentComplete = $statusType.GetProperty("PercentComplete").GetValue($status)
    errorCode = [string]$statusType.GetProperty("ErrorCode").GetValue($status)
  }
}

function Get-StoreFamilyStatus($items, [string]$packageFamily) {
  $listType = [System.Collections.Generic.IReadOnlyList``1].MakeGenericType($itemType)
  $collectionType = [System.Collections.Generic.IReadOnlyCollection``1].MakeGenericType($itemType)
  $count = $collectionType.GetProperty("Count").GetValue($items)
  for ($index = 0; $index -lt $count; $index++) {
    $item = $listType.GetProperty("Item").GetValue($items, @($index))
    $family = $itemType.GetProperty("PackageFamilyName").GetValue($item)
    if ([string]::Equals($family, $packageFamily, [System.StringComparison]::OrdinalIgnoreCase)) {
      return Get-StoreItemStatus $item
    }
  }
  return $null
}

$manager = $managerType::new()

if ($Action -eq "status") {
  $items = $managerType.GetProperty("AppInstallItems").GetValue($manager)
  $status = Get-StoreFamilyStatus $items $PackageFamily
  [pscustomobject]@{ status = $status } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq "check") {
  $listType = [System.Collections.Generic.IReadOnlyList``1].MakeGenericType($itemType)
  $updates = Wait-StoreOperation $manager.SearchForAllUpdatesAsync() $listType
  $status = Get-StoreFamilyStatus $updates $PackageFamily
  $available = $null -ne $status -and $status.state -notin @("Completed", "Canceled")
  [pscustomobject]@{ available = $available; status = $status } | ConvertTo-Json -Compress
  exit 0
}

$update = Wait-StoreOperation $manager.UpdateAppByPackageFamilyNameAsync($PackageFamily) $itemType
$status = if ($null -ne $update) { Get-StoreItemStatus $update } else { $null }
if ($null -eq $status) {
  $items = $managerType.GetProperty("AppInstallItems").GetValue($manager)
  $status = Get-StoreFamilyStatus $items $PackageFamily
}
$queued = $null -ne $status -and $status.state -notin @("Canceled", "Error")
[pscustomobject]@{ queued = $queued; status = $status } | ConvertTo-Json -Compress
