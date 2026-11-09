// Kamera di dalam aplikasi (getUserMedia). Sengaja TANPA pilih-berkas: foto etalase harus diambil
// langsung, bukan dari galeri. Berlaku di HP (kamera belakang) maupun laptop (webcam).
import { useEffect, useRef, useState } from "react";
import { compressImage, frameToCanvas } from "../lib/image.ts";
import { Modal } from "./common.tsx";
import { Icon } from "./icons.tsx";

export function CameraCapture({ onShot, onClose }: { onShot: (bytes: Uint8Array, previewUrl: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    setError(null);
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch(() => setError("Kamera tidak bisa dibuka. Izinkan akses kamera di browser."));
    if (!navigator.mediaDevices) setError("Perangkat ini tidak punya akses kamera.");
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [facing]);

  async function shoot() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    setBusy(true);
    try {
      const canvas = frameToCanvas(v);
      const bytes = await compressImage(canvas);
      onShot(bytes, URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Kamera" onClose={onClose}>
      <div className="camera">
        {error ? <div className="error" role="alert">{error}</div> : <video ref={video} autoPlay playsInline muted className="camera-view" />}
        <div className="row" style={{ justifyContent: "center", gap: 16 }}>
          <button className="btn icon round" aria-label="Ganti kamera" onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}>
            <Icon name="refresh" />
          </button>
          <button className="shutter" aria-label="Ambil foto" disabled={!!error || busy} onClick={() => void shoot()} />
          <button className="btn icon round" aria-label="Tutup kamera" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
      </div>
    </Modal>
  );
}
