// Ikon SVG inline (tanpa CDN — supaya CSP ketat & tidak ada skrip pihak ketiga).
import type { SVGProps } from "react";

const PATHS = {
  shield: "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z",
  shieldCheck: "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z M9 12l2 2 4-4",
  lock: "M6 11h12v9H6z M8 11V8a4 4 0 018 0v3",
  key: "M14.5 9.5a4 4 0 11-5.66 5.66 4 4 0 015.66-5.66z M14.5 9.5L20 4 M17 7l2 2",
  copy: "M9 9h10v10H9z M5 15V5h10",
  refresh: "M20 11a8 8 0 00-14.3-4.9L4 8 M4 4v4h4 M4 13a8 8 0 0014.3 4.9L20 16 M20 20v-4h-4",
  send: "M4 12l16-8-6 16-2.5-6.5L4 12z",
  vibrate: "M9 4h6v16H9z M5 8v8 M19 8v8 M2 10v4 M22 10v4",
  userPlus: "M15 19a6 6 0 00-12 0 M9 11a4 4 0 100-8 4 4 0 000 8z M19 8v6 M16 11h6",
  check: "M5 12l5 5L20 7",
  x: "M6 6l12 12 M18 6L6 18",
  settings:
    "M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
  back: "M15 18l-6-6 6-6",
  more: "M12 6h.01 M12 12h.01 M12 18h.01",
  ban: "M12 21a9 9 0 100-18 9 9 0 000 18z M5.6 5.6l12.8 12.8",
  logout: "M15 4h4v16h-4 M10 16l-4-4 4-4 M6 12h10",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13",
  share: "M12 3v12 M8 7l4-4 4 4 M5 13v7h14v-7",
  alert: "M12 3l10 18H2L12 3z M12 10v4 M12 17h.01",
  wifiOff: "M2 2l20 20 M8.5 16.5a5 5 0 017 0 M5 13a10 10 0 015.2-2.8 M19 13a10 10 0 00-2.2-1.6 M12 20h.01",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 15a3 3 0 100-6 3 3 0 000 6z",
  eyeOff: "M3 3l18 18 M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3 3.9 M6.6 6.6A17 17 0 002 12s3.5 7 10 7a9.7 9.7 0 005.4-1.6 M9.9 9.9a3 3 0 004.2 4.2",
  fingerprint: "M12 11v4 M8 8a5 5 0 018 4v1a10 10 0 01-1 4.5 M7 12a5 5 0 00.2 1.5 M5 6a8 8 0 0114 6v1 M4.5 15a8 8 0 01-.5-3 M10 20a14 14 0 002-7v-1",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18z M12 7v5l3 2",
  inbox: "M3 13h5l1 3h6l1-3h5 M5 5h14l2 8v6H3v-6l2-8z",
  store: "M4 10v10h16V10 M3 4h18l-1.5 6h-15L3 4z M9 20v-6h6v6",
  handshake: "M11 17l2 2a1.4 1.4 0 002-2 M14 14l2.5 2.5a1.4 1.4 0 002-2L15 11 M3 11l4-4 4 2 3-2 7 5 M3 11l5 5 M21 12l-3 3",
  wallet: "M3 7h16a2 2 0 012 2v9a2 2 0 01-2 2H3z M3 7l12-4v4 M16 14h.01",
  crown: "M3 18h18 M4 8l4 4 4-7 4 7 4-4-2 10H6L4 8z",
  plus: "M12 5v14 M5 12h14",
  edit: "M4 20h4L19 9l-4-4L4 16v4z M14 6l4 4",
  idcard: "M3 5h18v14H3z M8 11a2 2 0 100-4 2 2 0 000 4z M5 16a3 3 0 016 0 M14 9h4 M14 13h4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
