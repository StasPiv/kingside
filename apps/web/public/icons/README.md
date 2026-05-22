# KS-3237 PWA icons

`master.svg` / `master-maskable.svg` — мастер-исходники (512×512 viewBox)
для PNG-иконок этого каталога. Король нарисован как SVG-path (не emoji
и не `<text>`), чтобы рендер не зависел от системного шрифта.

## Перегенерация PNG

ImageMagick 6 (`convert`) есть на dev-машине:

```bash
cd apps/web/public/icons
convert -background none -density 600 master.svg -resize 512x512 icon-512.png
convert -background none -density 600 master.svg -resize 192x192 icon-192.png
convert -background none -density 600 master.svg -resize 180x180 icon-180.png
convert -background none -density 600 master-maskable.svg -resize 512x512 icon-512-maskable.png
```

- `icon-192.png` — Android home screen.
- `icon-512.png` — Android splash + большие лаунчер-ячейки.
- `icon-180.png` — `apple-touch-icon` для iOS Safari.
- `icon-512-maskable.png` — адаптивные лаунчеры (Pixel/OneUI), 75% safe-zone.

`master.svg` остаётся как fallback в manifest.icons (sizes="any") и как
favicon источник (`<link rel="icon" type="image/svg+xml" href="/icon.svg">`
в index.html — это другой файл, `apps/web/public/icon.svg`).
