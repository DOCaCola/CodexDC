param([ValidateSet('inspect', 'confirm', 'kill', 'error')][string]$Action)
$ErrorActionPreference = 'Stop'
$session = (Get-Process -Id $PID).SessionId
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

if ($Action -in @('inspect', 'kill')) {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-process-control.cs')
}

function Get-DesktopProcesses {
    $rows = @(Get-CimInstance Win32_Process -Filter "SessionId = $session")
    @($rows | ForEach-Object {
        [pscustomobject]@{
            pid = [int]$_.ProcessId
            parentPid = [int]$_.ParentProcessId
            executable = [string]$_.ExecutablePath
            commandLine = [string]$_.CommandLine
            startedAt = $_.CreationDate.ToUniversalTime().ToString('o')
            name = [string]$_.Name
            elevated = if ($_.Name -ieq 'codex.exe' -or $_.CommandLine -match '(?:^|\s)app-server(?:\s|$)') {
                [CodexDC.ProcessControl]::ReadElevation([int]$_.ProcessId)
            } else { $null }
        }
    })
}

if ($Action -eq 'inspect') {
    # This helper inherits the launcher's token. Inspect the token, not account membership.
    $launcherElevated = [CodexDC.ProcessControl]::ReadElevation($PID)
    if ($null -eq $launcherElevated) { throw 'Could not determine CodexDC launcher elevation.' }
    [pscustomobject]@{
        launcherElevated = [bool]$launcherElevated
        processes = @(Get-DesktopProcesses)
    } | ConvertTo-Json -Depth 3 -Compress
    exit 0
}

if ($Action -eq 'confirm') {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'CodexDC is already running with a different configuration'
    $form.Size = New-Object System.Drawing.Size(620, 360)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.TopMost = $true
    $label = New-Object System.Windows.Forms.Label
    $label.Location = New-Object System.Drawing.Point(20, 20)
    $label.Size = New-Object System.Drawing.Size(560, 230)
    $label.Text = [Environment]::GetEnvironmentVariable('CODEXDC_LAUNCH_WARNING')
    $form.Controls.Add($label)
    $kill = New-Object System.Windows.Forms.Button
    $kill.Text = 'Kill and start CodexDC'
    $kill.Size = New-Object System.Drawing.Size(210, 34)
    $kill.Location = New-Object System.Drawing.Point(260, 268)
    $kill.DialogResult = [System.Windows.Forms.DialogResult]::Yes
    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.Size = New-Object System.Drawing.Size(100, 34)
    $cancel.Location = New-Object System.Drawing.Point(480, 268)
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.Controls.AddRange(@($kill, $cancel))
    $form.AcceptButton = $cancel
    $form.CancelButton = $cancel
    $form.Add_Shown({ $cancel.Select() })
    try {
        if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::Yes) { 'kill' } else { 'cancel' }
    } finally { $form.Dispose() }
    exit 0
}

if ($Action -eq 'error') {
    Add-Type -AssemblyName System.Windows.Forms
    $null = [System.Windows.Forms.MessageBox]::Show(
        [Environment]::GetEnvironmentVariable('CODEXDC_LAUNCH_ERROR'),
        'CodexDC could not start',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
    exit 0
}

# The JSON comes from the inspected snapshot, never from a process name wildcard.
$targets = @([Environment]::GetEnvironmentVariable('CODEXDC_LAUNCH_TARGETS') | ConvertFrom-Json)
$rows = @(Get-CimInstance Win32_Process -Filter "SessionId = $session")
$selected = @{}
$handles = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
try {
    foreach ($target in $targets) {
        $row = $rows | Where-Object { $_.ProcessId -eq $target.pid } | Select-Object -First 1
        if (!$row) { continue }
        if ($row.ExecutablePath -ine $target.executable -or
            $row.CreationDate.ToUniversalTime().Ticks -ne ([datetime]::Parse($target.startedAt)).ToUniversalTime().Ticks) {
            throw "The running instance changed. No replacement process was terminated."
        }
        $selected[[int]$row.ProcessId] = $row
    }
    # Include owned descendants, but preserve any shared managed-daemon branch.
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($row in $rows) {
            if ($selected.ContainsKey([int]$row.ProcessId) -or !$selected.ContainsKey([int]$row.ParentProcessId)) { continue }
            if ($row.CommandLine -match '(?:^|\s)--managed-daemon(?:\s|$)') { continue }
            $parent = $selected[[int]$row.ParentProcessId]
            if ($row.CreationDate -lt $parent.CreationDate) { continue }
            $selected[[int]$row.ProcessId] = $row
            $changed = $true
        }
    }
    foreach ($row in $selected.Values) {
        try { $process = [System.Diagnostics.Process]::GetProcessById([int]$row.ProcessId) }
        catch [System.ArgumentException] { continue }
        # Hold verified process handles: an exited PID must not redirect a kill.
        try { $null = $process.Handle }
        catch {
            # A snapshot entry may have exited before its handle was opened.
            $process.Dispose()
            if (!(Get-CimInstance Win32_Process -Filter "ProcessId = $($row.ProcessId)")) { continue }
            throw
        }
        $handles.Add($process)
        if ($process.HasExited) { continue }
        # CIM reports microseconds; the held process handle reports 100ns ticks.
        if ([Math]::Abs($process.StartTime.ToUniversalTime().Ticks - $row.CreationDate.ToUniversalTime().Ticks) -gt 9) {
            throw "A process changed during launch. No process was terminated."
        }
        try { $sid = [CodexDC.ProcessControl]::OwnerSid($process.Handle) }
        catch {
            if ($process.WaitForExit(1000)) { continue }
            throw
        }
        if ($sid -ne $owner) { throw "Cannot terminate another user's Codex process." }
    }
    # Stop the roots first so they cannot keep creating new work.
    foreach ($process in @($handles | Sort-Object { if ($targets.pid -contains $_.Id) { 0 } else { 1 } })) {
        try {
            if (!$process.HasExited) { [CodexDC.ProcessControl]::Terminate($process.Handle) }
        } catch {
            # Owl's sandbox helpers can exit as soon as the root is killed.
            # The held handle distinguishes exit from a live denial and avoids
            # .NET Kill reopening a possibly recycled PID.
            if (!$process.WaitForExit(1000)) {
                throw "Cannot terminate Codex process $($process.Id): $($_.Exception.Message)"
            }
        }
    }
    foreach ($process in $handles) {
        if (!$process.WaitForExit(10000)) { throw "A Codex process did not exit. Launch cancelled." }
    }
} finally {
    foreach ($process in $handles) { $process.Dispose() }
}
