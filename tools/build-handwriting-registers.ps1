Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$sampleDir = Join-Path $projectRoot 'samples\handwriting\saqr'
$sourceRegister = Join-Path $projectRoot 'samples\register.jpg'

function New-TestRegister {
  param(
    [string]$OutputName,
    [int[]]$Rows,
    [bool]$Faded
  )

  $canvas = New-Object System.Drawing.Bitmap 1800, 1250
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  $graphics.Clear([System.Drawing.Color]::FromArgb(242, 236, 215))
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  $inkPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(95, 82, 60)), 2
  $thinPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(155, 139, 105)), 1
  $headerBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(25, 63, 59))
  $paperBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(250, 247, 235))
  $goldBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(174, 122, 45))
  $titleFont = New-Object System.Drawing.Font 'Georgia', 28, ([System.Drawing.FontStyle]::Bold)
  $smallFont = New-Object System.Drawing.Font 'Arial', 14, ([System.Drawing.FontStyle]::Bold)
  $numberFont = New-Object System.Drawing.Font 'Georgia', 20
  $handwritingAttributes = New-Object System.Drawing.Imaging.ImageAttributes
  $handwritingAttributes.SetColorKey(
    [System.Drawing.Color]::FromArgb(220, 220, 220),
    [System.Drawing.Color]::FromArgb(255, 255, 255)
  )

  $graphics.FillRectangle($headerBrush, 60, 55, 1680, 120)
  $graphics.DrawString('SESHAT / ARABIC HANDWRITING TEST REGISTER', $titleFont, [System.Drawing.Brushes]::White, 95, 85)
  $graphics.DrawString('Known-ground-truth evaluation page', $smallFont, $goldBrush, 1265, 102)

  $left = 80
  $top = 215
  $rowHeight = 225
  $widths = @(100, 1120, 190, 250)
  $headers = @('NO.', 'HANDWRITTEN DESCRIPTION', 'MATERIAL', 'PLATE')
  $cursor = $left
  for ($column = 0; $column -lt $widths.Count; $column++) {
    $graphics.FillRectangle($paperBrush, $cursor, $top, $widths[$column], 58)
    $graphics.DrawRectangle($inkPen, $cursor, $top, $widths[$column], 58)
    $graphics.DrawString($headers[$column], $smallFont, [System.Drawing.Brushes]::Black, $cursor + 12, $top + 18)
    $cursor += $widths[$column]
  }

  $registerImage = [System.Drawing.Image]::FromFile($sourceRegister)
  for ($index = 0; $index -lt $Rows.Count; $index++) {
    $rowTop = $top + 58 + ($index * $rowHeight)
    $cursor = $left
    foreach ($columnWidth in $widths) {
      $graphics.FillRectangle($paperBrush, $cursor, $rowTop, $columnWidth, $rowHeight)
      $graphics.DrawRectangle($thinPen, $cursor, $rowTop, $columnWidth, $rowHeight)
      $cursor += $columnWidth
    }

    $graphics.DrawString(([string](21 + $index)), $numberFont, [System.Drawing.Brushes]::Black, $left + 28, $rowTop + 82)
    $linePath = Join-Path $sampleDir ("saqr-test-{0:D2}.jpg" -f $Rows[$index])
    $lineImage = [System.Drawing.Image]::FromFile($linePath)
    $targetWidth = 1050
    $targetHeight = [Math]::Min(175, [Math]::Round($lineImage.Height * ($targetWidth / $lineImage.Width)))
    $targetY = $rowTop + [Math]::Round(($rowHeight - $targetHeight) / 2)
    $lineTarget = New-Object System.Drawing.Rectangle ($left + 125), $targetY, $targetWidth, $targetHeight
    $graphics.DrawImage(
      $lineImage,
      $lineTarget,
      0,
      0,
      $lineImage.Width,
      $lineImage.Height,
      [System.Drawing.GraphicsUnit]::Pixel,
      $handwritingAttributes
    )
    $lineImage.Dispose()

    $graphics.DrawString($(if ($index % 2 -eq 0) { 'STONE' } else { 'WOOD' }), $smallFont, [System.Drawing.Brushes]::Black, $left + 1250, $rowTop + 93)
    $sourceCrop = New-Object System.Drawing.Rectangle (1190 + (($index % 2) * 120)), (165 + ($index * 150)), 180, 150
    $plateTarget = New-Object System.Drawing.Rectangle ($left + 1430), ($rowTop + 26), 190, 170
    $graphics.DrawImage($registerImage, $plateTarget, $sourceCrop, [System.Drawing.GraphicsUnit]::Pixel)
  }
  $registerImage.Dispose()

  if ($Faded) {
    $veil = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(82, 250, 247, 235))
    $graphics.FillRectangle($veil, 0, 0, $canvas.Width, $canvas.Height)
    $veil.Dispose()
    for ($line = 0; $line -lt 22; $line++) {
      $y = 35 + ($line * 53)
      $graphics.DrawLine($thinPen, 0, $y, $canvas.Width, $y + 4)
    }
  }

  $outputPath = Join-Path $sampleDir $OutputName
  $canvas.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $titleFont.Dispose(); $smallFont.Dispose(); $numberFont.Dispose(); $handwritingAttributes.Dispose()
  $inkPen.Dispose(); $thinPen.Dispose(); $headerBrush.Dispose(); $paperBrush.Dispose(); $goldBrush.Dispose()
  $graphics.Dispose(); $canvas.Dispose()
  Write-Host "created $OutputName"
}

New-TestRegister -OutputName 'saqr-register-a.jpg' -Rows @(0, 1, 2, 3) -Faded $false
New-TestRegister -OutputName 'saqr-register-b-faded.jpg' -Rows @(4, 5, 6, 7) -Faded $true
