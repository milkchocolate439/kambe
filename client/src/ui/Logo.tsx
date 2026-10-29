// Identitas visual KAMBE ("Hadir tanpa jejak."): arwah putih-kabut di lingkaran malam,
// dibingkai sulur/aso ukiran Dayak merah api. Artwork sama persis dengan client/public/icon.svg.
// Tanpa <use>/id supaya beberapa logo di satu halaman tidak bentrok id.

const SULUR =
  "M196 78C230 66 282 66 316 78C340 88 346 116 326 124C310 130 300 116 310 106M196 78C172 88 166 116 186 124C202 130 212 116 202 106";

const ARWAH =
  "M150 232C150 162 196 112 256 112C316 112 362 162 362 232V384Q362 402 344 394L318 380Q302 372 288 386L274 400Q256 416 238 400L224 386Q210 372 194 380L168 394Q150 402 150 384Z" +
  "M201 240a17 25 0 1 0 34 0a17 25 0 1 0-34 0Z" +
  "M277 240a17 25 0 1 0 34 0a17 25 0 1 0-34 0Z";

const SULUR_ROTATIONS = [0, 90, -90];

export function Logo({ size = 40, title }: { size?: number; title?: string }) {
  const a11y = title ? { role: "img" as const } : { "aria-hidden": true as const };
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" focusable="false" {...a11y}>
      {title && <title>{title}</title>}
      <circle cx="256" cy="256" r="256" fill="#0E0B0A" />
      <g fill="none" stroke="#E4572E" strokeLinecap="round" strokeLinejoin="round" strokeWidth="14">
        <circle cx="256" cy="256" r="230" />
        {SULUR_ROTATIONS.map((deg) => (
          <path key={deg} d={SULUR} transform={deg ? `rotate(${deg} 256 256)` : undefined} />
        ))}
      </g>
      <path fill="#EEE9E2" fillRule="evenodd" transform="translate(256 262) scale(0.88) translate(-256 -262)" d={ARWAH} />
    </svg>
  );
}

/** Tulisan "KAMBE" (teks asli, terbaca pembaca layar) dengan titik bara merah kecil. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className ? `wordmark ${className}` : "wordmark"}>
      KAMBE
      <span className="wordmark-dot" aria-hidden="true" />
    </span>
  );
}
