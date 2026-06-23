/**
 * KS-4589: inline-SVG логотипа Patreon. Используем именно inline-SVG
 * (а не `<img src="/patreon-logo.svg">`), потому что `<img>` не
 * наследует CSS-цвет — `fill="currentColor"` в файле не работает,
 * и на цветной кнопке (коралл/тёмный фон) логотип остаётся в дефолтном
 * чёрном. Inline-SVG корректно наследует `color` от родителя.
 *
 * Геометрия — официальный «P»-mark Patreon (см. брендбук
 * https://www.patreon.com/brand): вертикальная стойка + круг-петля.
 * Тот же исходник лежит в `apps/web/public/patreon-logo.svg` для
 * случаев, когда нужен внешний файл (например, og-картинка).
 */
import type { CSSProperties } from 'react';

interface Props {
  className?: string;
  style?: CSSProperties;
  /** Размер квадрата SVG в пикселях. По умолчанию 18. */
  size?: number;
  /** Заголовок для скринридеров. По умолчанию «Patreon». */
  title?: string;
}

export function PatreonLogo({
  className,
  style,
  size = 18,
  title = 'Patreon',
}: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 569 569"
      width={size}
      height={size}
      fill="currentColor"
      role="img"
      aria-label={title}
      className={className}
      style={style}
    >
      <title>{title}</title>
      <rect width="100" height="569" x="0" y="0" />
      <circle cx="362.589" cy="204.589" r="204.589" />
    </svg>
  );
}
