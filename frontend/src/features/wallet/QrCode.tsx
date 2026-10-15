import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/**
 * A QR code drawn as one SVG path. Always dark-on-white with a quiet zone,
 * whatever the theme: scanners need the contrast.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    // Uppercase fits QR's compact alphanumeric mode; BOLT11 is case-insensitive.
    qr.addData(value.toUpperCase(), 'Alphanumeric');
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
      }
    }
    return { size: n + 8, path: d };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="h-auto w-full max-w-[18rem] rounded-lg"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
