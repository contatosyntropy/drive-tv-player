$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ffprobe = Join-Path $root "bin\ffprobe.exe"
$ffplay = Join-Path $root "bin\ffplay.exe"

if (!(Test-Path $ffprobe) -or !(Test-Path $ffplay)) {
  Write-Host "FFmpeg nao foi encontrado na pasta bin." -ForegroundColor Red
  Read-Host "Pressione Enter para sair"
  exit 1
}

Write-Host ""
Write-Host "DRIVE TV PLAYER - TESTE DE DESKTOP" -ForegroundColor Cyan
Write-Host "Este teste usa FFmpeg no Windows e nao altera o app da TV."
Write-Host ""

$url = Read-Host "Cole a URL completa do endpoint /api/video/... (ou Enter para montar)"
if ([string]::IsNullOrWhiteSpace($url)) {
  $base = Read-Host "URL base do Worker [https://drive-tv-player.contatosyntropy.workers.dev]"
  if ([string]::IsNullOrWhiteSpace($base)) { $base = "https://drive-tv-player.contatosyntropy.workers.dev" }
  $fileId = Read-Host "ID do arquivo no Google Drive"
  $fileName = Read-Host "Nome do arquivo, incluindo .mkv"
  $secureKey = Read-Host "Chave da API (entrada oculta)" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try { $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  $url = $base.TrimEnd("/") + "/api/video/" + [Uri]::EscapeDataString($fileId) + "/" +
    [Uri]::EscapeDataString($fileName) + "?key=" + [Uri]::EscapeDataString($apiKey)
  $apiKey = $null
}

try {
  $uri = [Uri]$url
  if ($uri.Scheme -ne "https" -and $uri.Scheme -ne "http") { throw "A URL precisa usar HTTP ou HTTPS." }
} catch {
  Write-Host "URL invalida: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host "Pressione Enter para sair"
  exit 1
}

Add-Type -AssemblyName System.Net.Http
$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(35)

function Test-ByteRange([long]$start, [long]$end, [string]$label) {
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $uri)
  $request.Headers.Range = [System.Net.Http.Headers.RangeHeaderValue]::new($start, $end)
  try {
    $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $buffer = New-Object byte[] 16
    $read = $stream.Read($buffer, 0, $buffer.Length)
    $cr = $response.Content.Headers.ContentRange
    $rangeText = if ($cr) { "bytes $($cr.From)-$($cr.To)/$($cr.Length)" } else { "ausente" }
    $status = [int]$response.StatusCode
    $ok = ($status -eq 206 -and $cr -and $cr.From -eq $start)
    [PSCustomObject]@{
      Teste = $label
      HTTP = $status
      ContentRange = $rangeText
      BytesLidos = $read
      Resultado = if ($ok) { "OK" } else { "FALHOU" }
      Total = if ($cr -and $cr.Length) { [long]$cr.Length } else { $null }
    }
    $stream.Dispose()
    $response.Dispose()
  } catch {
    [PSCustomObject]@{ Teste=$label; HTTP="ERRO"; ContentRange=$_.Exception.Message; BytesLidos=0; Resultado="FALHOU"; Total=$null }
  } finally {
    $request.Dispose()
  }
}

Write-Host ""
Write-Host "1. TESTE DE HTTP RANGE" -ForegroundColor Cyan
$first = Test-ByteRange 0 4095 "Inicio"
$first | Format-Table -AutoSize
$total = $first.Total
if ($total -and $total -gt 8192) {
  $ranges = @(
    (Test-ByteRange 1048576 1052671 "1 MiB"),
    (Test-ByteRange ([long][Math]::Floor($total / 2)) ([long][Math]::Floor($total / 2) + 4095) "Meio"),
    (Test-ByteRange ([long][Math]::Floor($total * 0.9)) ([long][Math]::Floor($total * 0.9) + 4095) "90%"),
    (Test-ByteRange ([Math]::Max(0, $total - 4096)) ($total - 1) "Final")
  )
  $ranges | Format-Table -AutoSize
}
$client.Dispose()

if ($first.Result -ne "OK") {
  Write-Host "O Worker nao confirmou HTTP 206 com Content-Range. O FFmpeg pode nao conseguir buscar partes do arquivo." -ForegroundColor Yellow
} else {
  Write-Host "HTTP Range respondeu 206 no inicio do arquivo." -ForegroundColor Green
}

Write-Host ""
Write-Host "2. ANALISE DO CONTAINER E DOS CODECS (FFprobe)" -ForegroundColor Cyan
$probeArgs = @(
  "-v", "error",
  "-show_entries", "format=format_name,duration,size:stream=index,codec_type,codec_name,profile,width,height,channels,sample_rate",
  "-of", "json",
  $url
)
$probe = & $ffprobe @probeArgs 2>&1
$probeExit = $LASTEXITCODE
$probe | ForEach-Object { Write-Host $_ }
if ($probeExit -ne 0) {
  Write-Host "FFprobe falhou (codigo $probeExit). Veja se a URL, permissao ou entrega do Worker esta correta." -ForegroundColor Red
  Read-Host "Pressione Enter para sair"
  exit $probeExit
}

Write-Host ""
Write-Host "3. REPRODUCAO NO COMPUTADOR (FFplay)" -ForegroundColor Cyan
Write-Host "A janela de video sera aberta. Feche-a ou pressione Esc para encerrar."
Write-Host "A decodificacao aqui e feita pelo PC, nao pelo hardware da TV."
& $ffplay -hide_banner -loglevel warning -stats $url
$playExit = $LASTEXITCODE

Write-Host ""
if ($playExit -eq 0) {
  Write-Host "Teste finalizado. FFmpeg conseguiu abrir a fonte." -ForegroundColor Green
} else {
  Write-Host "FFplay terminou com codigo $playExit. A mensagem acima pode indicar a causa." -ForegroundColor Yellow
}
Read-Host "Pressione Enter para fechar"
