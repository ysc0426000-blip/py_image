# 圖片辨識系統 - 本機靜態網頁伺服器
# 用途：在本機啟動一個網頁伺服器，讓瀏覽器可以用 http://localhost 開啟系統
#      （相機/麥克風權限在瀏覽器中要求 https 或 localhost 才能使用，
#       所以不能直接用「開啟檔案」的方式打開 index.html）
#
# 設計重點：每個請求都在獨立的 Runspace 中處理，避免單一緩慢或中斷的連線
#          （例如下載大型模型檔案到一半就離開頁面）卡住整個伺服器。

param(
    [int]$Port = 8787
)

$root = $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Host "無法啟動伺服器於 $prefix" -ForegroundColor Red
    Write-Host $_
    exit 1
}

Write-Host "圖片辨識系統伺服器已啟動" -ForegroundColor Green
Write-Host "請在瀏覽器（建議使用 Chrome 或 Edge）開啟： $prefix" -ForegroundColor Cyan
Write-Host "按 Ctrl+C 可停止伺服器" -ForegroundColor Yellow

$mimeMap = @{
    ".html" = "text/html; charset=utf-8"
    ".htm"  = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".png"  = "image/png"
    ".webp" = "image/webp"
    ".gif"  = "image/gif"
    ".ico"  = "image/x-icon"
    ".bin"  = "application/octet-stream"
}

$imageExtensions = @(".jpg", ".jpeg", ".png", ".webp")

# 啟動後自動開啟預設瀏覽器
try {
    Start-Process $prefix
} catch {
    Write-Host "無法自動開啟瀏覽器，請手動開啟 $prefix"
}

$runspacePool = [runspacefactory]::CreateRunspacePool(1, 8)
$runspacePool.Open()

$handlerScript = {
    param($context, $root, $mimeMap, $imageExtensions)

    $request = $context.Request
    $response = $context.Response

    function Get-LocalContentType($path, $mimeMap) {
        $ext = [System.IO.Path]::GetExtension($path).ToLower()
        if ($mimeMap.ContainsKey($ext)) { return $mimeMap[$ext] }
        return "application/octet-stream"
    }

    try {
        $urlPath = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)

        if ($urlPath -eq "/api/images") {
            $files = Get-ChildItem -Path $root -File | Where-Object {
                $imageExtensions -contains $_.Extension.ToLower() -and -not $_.Name.StartsWith("~$")
            } | Sort-Object Name | ForEach-Object {
                [PSCustomObject]@{
                    name  = $_.Name
                    size  = $_.Length
                    mtime = $_.LastWriteTimeUtc.Ticks
                }
            }
            $filesArray = @($files)
            if ($filesArray.Count -eq 0) {
                $json = "[]"
            } elseif ($filesArray.Count -eq 1) {
                $json = "[" + ($filesArray[0] | ConvertTo-Json -Depth 3 -Compress) + "]"
            } else {
                $json = $filesArray | ConvertTo-Json -Depth 3 -Compress
            }
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            $response.ContentType = "application/json; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        }
        else {
            if ($urlPath -eq "/") { $urlPath = "/index.html" }
            # 避免路徑跳脫到專案資料夾外
            $relativePath = $urlPath.TrimStart("/") -replace "/", [System.IO.Path]::DirectorySeparatorChar
            $fullPath = [System.IO.Path]::GetFullPath((Join-Path $root $relativePath))

            if (-not $fullPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $response.StatusCode = 403
            }
            elseif (-not (Test-Path $fullPath -PathType Leaf)) {
                $response.StatusCode = 404
                $bytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $urlPath")
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
            else {
                $bytes = [System.IO.File]::ReadAllBytes($fullPath)
                $response.ContentType = Get-LocalContentType $fullPath $mimeMap
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        }
    } catch {
        try {
            $response.StatusCode = 500
            $bytes = [System.Text.Encoding]::UTF8.GetBytes("500 Server Error: $_")
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } catch {}
    } finally {
        try { $response.OutputStream.Close() } catch {}
    }
}

$pending = New-Object System.Collections.Generic.List[object]

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
    } catch {
        break
    }

    $ps = [powershell]::Create()
    $ps.RunspacePool = $runspacePool
    [void]$ps.AddScript($handlerScript).AddArgument($context).AddArgument($root).AddArgument($mimeMap).AddArgument($imageExtensions)
    $asyncResult = $ps.BeginInvoke()
    $pending.Add([PSCustomObject]@{ PS = $ps; Handle = $asyncResult })

    # 順便清理已完成的工作，避免無限累積
    for ($i = $pending.Count - 1; $i -ge 0; $i--) {
        if ($pending[$i].Handle.IsCompleted) {
            try { $pending[$i].PS.EndInvoke($pending[$i].Handle) } catch {}
            $pending[$i].PS.Dispose()
            $pending.RemoveAt($i)
        }
    }
}

foreach ($job in $pending) {
    try { $job.PS.Stop() } catch {}
    $job.PS.Dispose()
}
$runspacePool.Close()
$runspacePool.Dispose()
$listener.Stop()
$listener.Close()

