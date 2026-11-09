import { useEffect, useRef, useState } from "react";
import { panicWipe, reloadAfterWipe } from "../lib/panic.ts";
import { Icon } from "./icons.tsx";

export const PANIC_HOLD_MS = 2000;

/**
 * Tombol Panic Wipe: harus DITAHAN 2 detik (mouse, sentuh, atau tombol Spasi/Enter) supaya tidak
 * terpencet tidak sengaja. Melepas sebelum waktunya membatalkan.
 */
export function PanicWipeButton({ deletePassphrase }: { deletePassphrase?: string }) {
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const raf = useRef<number | null>(null);
  const start = useRef(0);

  function cancel() {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (!running) setProgress(0);
  }

  async function fire() {
    setRunning(true);
    const report = await panicWipe(deletePassphrase || undefined);
    reloadAfterWipe(report);
  }

  function begin() {
    if (running || raf.current !== null) return;
    start.current = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start.current) / PANIC_HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        raf.current = null;
        void fire();
      } else raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }

  useEffect(() => () => cancel(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <button
      type="button"
      className="btn danger block panic-hold"
      style={{ ["--hold" as string]: `${Math.round(progress * 100)}%` }}
      disabled={running}
      aria-label="Panic Wipe: tahan 2 detik untuk menghapus semua data di perangkat ini"
      onPointerDown={begin}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !e.repeat && (e.preventDefault(), begin())}
      onKeyUp={(e) => (e.key === " " || e.key === "Enter") && cancel()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Icon name="trash" /> {running ? "Menghapus jejak…" : progress > 0 ? "Tahan terus…" : "PANIC WIPE — tahan 2 detik"}
    </button>
  );
}
