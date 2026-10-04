# Creates a read-only app key for the BECS OS dashboard.
# Asks for the master key (hidden), copies the NEW key to the clipboard, and never prints either key.
$ErrorActionPreference = 'Stop'
$base = 'https://becs-os-api.be-consulting-solutions.workers.dev'
$app = 'becs-dashboard'
$scopes = @('tasks:read', 'clients:read', 'ventures:read', 'projects:read')

$secure = Read-Host 'Paste your MASTER key (typing is hidden), then press Enter' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$master = $null
try {
    $master = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if (-not $master) { throw 'No key entered.' }
    $body = @{ app = $app; scopes = $scopes } | ConvertTo-Json -Compress
    $res = Invoke-RestMethod -Method Post -Uri "$base/admin/keys" `
        -Headers @{ Authorization = "Bearer $master" } -ContentType 'application/json' -Body $body
    Set-Clipboard -Value $res.data.key
    Write-Host ''
    Write-Host "Done. Key for '$app' is on your clipboard (not shown here)." -ForegroundColor Green
    Write-Host 'Scopes: ' ($res.data.scopes -join ', ')
    Write-Host 'Paste it into your password manager NOW. It cannot be shown again.'
}
catch {
    $code = $_.Exception.Response.StatusCode.value__
    Write-Host ''
    if ($code -eq 401) { Write-Host 'Failed: master key was not accepted (401).' -ForegroundColor Red }
    elseif ($code) { Write-Host "Failed: server returned $code." -ForegroundColor Red }
    else { Write-Host 'Failed:' $_.Exception.Message -ForegroundColor Red }
}
finally {
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $master = $null; $res = $null; $secure = $null
}
