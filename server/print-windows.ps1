param(
  [Parameter(Mandatory = $true)][string]$FilePath,
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][int]$Copies
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($FilePath)
try {
  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.PrinterSettings.PrinterName = $PrinterName
  if (-not $doc.PrinterSettings.IsValid) {
    throw "Printer not found or not ready: $PrinterName"
  }
  $doc.PrinterSettings.Copies = [int16]$Copies

  # 2026-08-13 (frame corners getting cropped at print time) — this used to
  # trust whatever paper size/orientation was already the driver's default,
  # set manually once in Windows' printer properties UI. Our composited file
  # is always exactly 4x6in portrait (server/compose.js), so if that manual
  # default ever drifts (driver update, a different paper size briefly
  # selected for a test print, a second printer sharing the same driver
  # profile), .NET stretches our 4x6 image into whatever the wrong page box
  # turns out to be and the frame's edges get cut off — with nothing in our
  # own code to blame. Selecting the driver's own '~4x6' PaperSize (falling
  # back to a custom one if the driver doesn't expose one) and forcing
  # portrait + zero margins makes this deterministic instead of depending on
  # a manual setting nobody will remember to re-check on event day.
  $target = $doc.PrinterSettings.PaperSizes | Where-Object {
    [Math]::Abs($_.Width - 400) -le 20 -and [Math]::Abs($_.Height - 600) -le 20
  } | Select-Object -First 1
  if ($target) {
    $doc.DefaultPageSettings.PaperSize = $target
  } else {
    $doc.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('4x6', 400, 600)
  }
  $doc.DefaultPageSettings.Landscape = $false
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)

  $doc.add_PrintPage({
    param($sender, $e)
    $e.Graphics.DrawImage($img, $e.PageBounds)
  })
  $doc.Print()
} finally {
  $img.Dispose()
}
