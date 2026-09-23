# 產生 images.json 靜態清單
# 用途：雲端部署（例如 Zeabur）沒有 server.ps1 可以動態掃描資料夾，
#      所以部署前要跑這支腳本，把目前資料夾內的圖片清單「烘焙」成靜態的 images.json，
#      app.js 在偵測不到 /api/images 動態端點時會自動改讀這個檔案。
#
# 使用時機：每次新增/刪除圖片之後、要 commit/push 之前，重新執行一次這支腳本。

$root = $PSScriptRoot
$imageExtensions = @(".jpg", ".jpeg", ".png", ".webp")

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

$outPath = Join-Path $root "images.json"
[System.IO.File]::WriteAllText($outPath, $json, [System.Text.Encoding]::UTF8)

Write-Host "已寫入 images.json，共 $($filesArray.Count) 張圖片。" -ForegroundColor Green

