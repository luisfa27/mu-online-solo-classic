# MU Online Solo Classic - Pure PowerShell Local Web Server
# Requer nenhum pacote externo (Node.js ou Python)

param (
    [int]$Port = 8088
)

$WebDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $WebDir) { $WebDir = (Get-Location).Path }
if (Test-Path (Join-Path $WebDir "web")) {
    $WebDir = Join-Path $WebDir "web"
}
$WebDir = (Resolve-Path $WebDir).Path

$MimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".wasm" = "application/wasm"
    ".data" = "application/octet-stream"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".musav"= "application/json; charset=utf-8"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".ico"  = "image/x-icon"
    ".mp3"  = "audio/mpeg"
    ".wav"  = "audio/wav"
}

$Listener = New-Object System.Net.HttpListener
$Prefix1 = "http://localhost:$Port/"
$Prefix2 = "http://127.0.0.1:$Port/"
$Listener.Prefixes.Add($Prefix1)
$Listener.Prefixes.Add($Prefix2)

try {
    $Listener.Start()
} catch {
    Write-Host "Falha ao iniciar na porta $Port. Tentando porta 8080..." -ForegroundColor Yellow
    $Port = 8080
    $Listener = New-Object System.Net.HttpListener
    $Prefix1 = "http://localhost:$Port/"
    $Prefix2 = "http://127.0.0.1:$Port/"
    $Listener.Prefixes.Add($Prefix1)
    $Listener.Prefixes.Add($Prefix2)
    try {
        $Listener.Start()
    } catch {
        Write-Error "Nao foi possivel iniciar o servidor: $_"
        exit 1
    }
}

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  MU Online Solo Classic - Servidor Offline" -ForegroundColor Cyan
Write-Host "  Pasta:     $WebDir" -ForegroundColor Gray
Write-Host "  Link:      http://localhost:$Port/" -ForegroundColor Yellow
Write-Host "  Link IP:   http://127.0.0.1:$Port/" -ForegroundColor Yellow
Write-Host "  Pressione Ctrl+C nesta janela para parar o servidor" -ForegroundColor Gray
Write-Host "==========================================================" -ForegroundColor Green

# Abrir automaticamente o navegador no endereco correto
try {
    Start-Process "http://localhost:$Port/"
} catch {}

$buffer = New-Object byte[] 65536

try {
    while ($Listener.IsListening) {
        $context = $Listener.GetContext()
        $req = $context.Request
        $res = $context.Response

        # Headers obrigatorios para WebAssembly com SharedArrayBuffer
        $res.Headers.Add("Cross-Origin-Opener-Policy", "same-origin")
        $res.Headers.Add("Cross-Origin-Embedder-Policy", "require-corp")
        $res.Headers.Add("Access-Control-Allow-Origin", "*")

        $urlPath = $req.Url.LocalPath
        if ($urlPath -eq "/" -or [string]::IsNullOrWhiteSpace($urlPath)) {
            $urlPath = "/index.html"
        }

        # Normalizar caminho de arquivo local
        $relPath = $urlPath.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
        $fullPath = [System.IO.Path]::Combine($WebDir, $relPath)

        if (-not [System.IO.File]::Exists($fullPath)) {
            $res.StatusCode = 404
            $res.ContentType = "text/plain; charset=utf-8"
            $errBytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $urlPath")
            $res.ContentLength64 = $errBytes.Length
            $res.OutputStream.Write($errBytes, 0, $errBytes.Length)
            $res.OutputStream.Close()
            continue
        }

        $ext = [System.IO.Path]::GetExtension($fullPath).ToLower()
        $mime = if ($MimeTypes.ContainsKey($ext)) { $MimeTypes[$ext] } else { "application/octet-stream" }
        $res.ContentType = $mime

        $fileInfo = New-Object System.IO.FileInfo($fullPath)
        $res.ContentLength64 = $fileInfo.Length

        if ($req.HttpMethod -eq "HEAD") {
            $res.OutputStream.Close()
            continue
        }

        try {
            $fs = [System.IO.File]::OpenRead($fullPath)
            while (($bytesRead = $fs.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $res.OutputStream.Write($buffer, 0, $bytesRead)
            }
            $fs.Close()
        } catch {
            # Conexao fechada pelo cliente
        } finally {
            $res.OutputStream.Close()
        }
    }
} finally {
    $Listener.Stop()
    $Listener.Close()
}
