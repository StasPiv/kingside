/**
 * KS-3094: общая логика обрезки картинки для повторной попытки
 * распознавания доски. Канвас-кроп — небольшая чистая функция, она же
 * тестируема в изоляции.
 *
 * `Area` совпадает с типом `react-easy-crop`'а (поля file/rank здесь
 * пиксельные координаты в исходном изображении). Возвращаем
 * `Blob` PNG'ом — recognizer принимает `File | Blob`.
 */

export interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PNG_MIME = 'image/png';

/**
 * Загружает Blob/URL в `<img>` через `createObjectURL` и ждёт `onload`.
 * Используется для канвас-кропа: нам нужны реальные пиксели исходника,
 * не объект-URL react-easy-crop'а (он же видит тот же src через
 * собственный `<img>`).
 */
export async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image-load-failed'));
    img.crossOrigin = 'anonymous';
    img.src = src;
  });
}

/**
 * Вырезает `area` из исходной картинки в PNG-Blob. Размер выходного
 * blob равен `area.width × area.height` (без масштабирования) — модель
 * сама ресайзит до собственного входа.
 *
 * Если canvas.toBlob недоступен (старые JSDOM в тестах), фолбэк через
 * `toDataURL` + ручной декод в Blob.
 */
export async function cropImageToBlob(
  src: string,
  area: CropArea,
): Promise<Blob> {
  const img = await loadImage(src);
  const w = Math.max(1, Math.round(area.width));
  const h = Math.max(1, Math.round(area.height));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas-context-unavailable');
  ctx.drawImage(
    img,
    Math.round(area.x),
    Math.round(area.y),
    Math.round(area.width),
    Math.round(area.height),
    0,
    0,
    w,
    h,
  );
  if (typeof canvas.toBlob === 'function') {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob-null'))),
        PNG_MIME,
      );
    });
  }
  // Fallback: toDataURL → atob → Uint8Array → Blob.
  const dataUrl = canvas.toDataURL(PNG_MIME);
  const base64 = dataUrl.split(',', 2)[1] ?? '';
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: PNG_MIME });
}

/**
 * KS-3094: начальный crop-rect для оверлея — квадрат, 80%
 * min(width, height), центрирован. Если ширина и высота известны
 * (HTMLImageElement loaded), считаем по факту; иначе возвращаем
 * относительные значения через crop {x,y} react-easy-crop'а.
 */
export function defaultSquareCrop(
  imageWidth: number,
  imageHeight: number,
): CropArea {
  const side = 0.8 * Math.min(imageWidth, imageHeight);
  return {
    x: (imageWidth - side) / 2,
    y: (imageHeight - side) / 2,
    width: side,
    height: side,
  };
}
