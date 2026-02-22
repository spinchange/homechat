# Manage-HomeChat.ps1
# Usage: .\Manage-HomeChat.ps1 <start|stop|restart|status|logs|install|uninstall>
param([string]$Command = "help")

$HomeChatDir = $PSScriptRoot
$LogDir      = Join-Path $HomeChatDir "logs"
$LogFile     = Join-Path $LogDir "server.log"
$TaskName    = "HomeChat"

function hc-ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function hc-info($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function hc-warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function hc-fail($msg) { Write-Host "  $msg" -ForegroundColor Red }
function hc-dim($msg)  { Write-Host "  $msg" -ForegroundColor DarkGray }

function Get-HCPid {
    $line = netstat -ano 2>$null | Select-String "TCP.*:3000\s+.*LISTENING"
    if ($line) { return [int](($line.ToString().Trim() -split '\s+')[-1]) }
    return $null
}

function Get-HCNetworkIP {
    # Prefer Wi-Fi, then Ethernet; skip virtual, loopback, and link-local (169.254.x.x)
    $addr = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object {
                $_.IPAddress -ne "127.0.0.1" -and
                !$_.IPAddress.StartsWith("169.254") -and
                $_.InterfaceAlias -notlike "*Loopback*" -and
                $_.InterfaceAlias -notlike "vEthernet*"
            } |
            Sort-Object { if ($_.InterfaceAlias -like "Wi-Fi*") { 0 } elseif ($_.InterfaceAlias -like "Ethernet*") { 1 } else { 2 } } |
            Select-Object -First 1
    if ($addr) { return $addr.IPAddress }
    return $null
}

function HC-Start {
    $existing = Get-HCPid
    if ($existing) {
        hc-warn "HomeChat is already running (PID $existing)."
        return
    }
    if (!(Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
    Add-Content $LogFile "=== Started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
    Start-Process "cmd.exe" `
        -ArgumentList "/c node server.js >> `"$LogFile`" 2>&1" `
        -WorkingDirectory $HomeChatDir `
        -WindowStyle Hidden
    Start-Sleep -Milliseconds 1500
    $newPid = Get-HCPid
    if ($newPid) {
        hc-ok "HomeChat started (PID $newPid)"
        hc-info "Local:    http://localhost:3000"
        $ip = Get-HCNetworkIP
        if ($ip) { hc-info "Network:  http://${ip}:3000" }
    } else {
        hc-fail "Server did not start. Check logs: $LogFile"
    }
}

function HC-Stop {
    $hcPid = Get-HCPid
    if (!$hcPid) {
        hc-warn "HomeChat is not running."
        return
    }
    Stop-Process -Id $hcPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    if (!(Get-HCPid)) {
        hc-ok "HomeChat stopped."
    } else {
        hc-fail "Could not stop process (PID $hcPid)."
    }
}

function HC-Status {
    $hcPid = Get-HCPid
    Write-Host ""
    if ($hcPid) {
        $proc = Get-Process -Id $hcPid -ErrorAction SilentlyContinue
        hc-ok "HomeChat is RUNNING"
        hc-info "PID:      $hcPid"
        if ($proc) {
            $mem = [math]::Round($proc.WorkingSet64 / 1MB, 1)
            $cpu = [math]::Round($proc.CPU, 1)
            $up  = (Get-Date) - $proc.StartTime
            hc-info "Memory:   ${mem} MB   CPU: ${cpu}s"
            hc-info "Uptime:   $($up.Days)d $($up.Hours)h $($up.Minutes)m"
        }
        hc-info "Local:    http://localhost:3000"
        $ip = Get-HCNetworkIP
        if ($ip) { hc-info "Network:  http://${ip}:3000" }
    } else {
        hc-warn "HomeChat is STOPPED"
    }
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        hc-ok "Auto-start: installed (runs at login)"
    } else {
        hc-warn "Auto-start: not installed -- run: homechat install"
    }
    Write-Host ""
}

function HC-Logs {
    if (!(Test-Path $LogFile)) {
        hc-warn "No log file yet -- server has not been started."
        return
    }
    hc-dim "--- Last 60 lines of server.log ---"
    Get-Content $LogFile | Select-Object -Last 60
    hc-dim "-----------------------------------"
    hc-info "Full log: $LogFile"
}

function HC-Install {
    $psExe  = (Get-Command powershell.exe).Source
    $script = Join-Path $HomeChatDir "Manage-HomeChat.ps1"
    $arg    = "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$script`" start"
    $action   = New-ScheduledTaskAction -Execute $psExe -Argument $arg -WorkingDirectory $HomeChatDir
    $trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 2) `
        -StartWhenAvailable
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -RunLevel Limited `
        -Force | Out-Null
    hc-ok "Auto-start installed."
    hc-info "HomeChat will start automatically every time you log in."
    hc-info "To remove: homechat uninstall"
}

function HC-Uninstall {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        hc-ok "Auto-start removed."
    } else {
        hc-warn "Auto-start task not found."
    }
}

function HC-Help {
    Write-Host ""
    Write-Host "  HomeChat Manager" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  start      Start the server"
    Write-Host "  stop       Stop the server"
    Write-Host "  restart    Stop then start"
    Write-Host "  status     Show running state, PID, URLs, uptime"
    Write-Host "  logs       Show last 60 lines of server output"
    Write-Host "  install    Set up auto-start at every login"
    Write-Host "  uninstall  Remove auto-start"
    Write-Host ""
}

$cmd = $Command.ToLower().Trim()

if     ($cmd -eq "start")     { HC-Start }
elseif ($cmd -eq "stop")      { HC-Stop }
elseif ($cmd -eq "restart")   { HC-Stop; Start-Sleep 1; HC-Start }
elseif ($cmd -eq "status")    { HC-Status }
elseif ($cmd -eq "logs")      { HC-Logs }
elseif ($cmd -eq "install")   { HC-Install }
elseif ($cmd -eq "uninstall") { HC-Uninstall }
else                          { HC-Help }
