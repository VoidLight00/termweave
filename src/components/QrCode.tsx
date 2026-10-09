import { useMemo } from "react";
import qrcode from "qrcode-generator";

import "./QrCode.css";

const QUIET_ZONE = 4;

/**
 * A QR code as inline SVG. It is dark modules on a white field in both themes: phone cameras
 * read inverted codes unreliably. That makes it an image, not chrome, so the no-color-literals
 * rule for component CSS does not reach these two fills.
 */
export function QrCode({ value, label, size = 168 }: { value: string; label: string; size?: number }) {
  const { path, cells } = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(value);
    code.make();
    const count = code.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) if (code.isDark(row, col)) d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    }
    return { path: d, cells: count + QUIET_ZONE * 2 };
  }, [value]);
  return (
    <svg className="qr" viewBox={`0 0 ${cells} ${cells}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={cells} height={cells} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
