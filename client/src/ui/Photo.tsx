// Foto terenkripsi: diunduh sebagai blob acak, dibuka (didekripsi) di perangkat, lalu ditampilkan.
import { useEffect, useState } from "react";
import { Modal, useMessenger } from "./common.tsx";
import { Icon } from "./icons.tsx";

export function AttachmentImage({ refRaw, alt, size = 64, zoom = true }: { refRaw: unknown; alt: string; size?: number; zoom?: boolean }) {
  const [, m] = useMessenger();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    m.attachmentUrl(refRaw).then(
      (u) => live && setUrl(u),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [m, refRaw]);

  const box = { width: size, height: size };
  if (failed) {
    return (
      <span className="photo-thumb empty" style={box} role="img" aria-label={`${alt} (tidak bisa dibuka)`}>
        <Icon name="lock" size={16} />
      </span>
    );
  }
  if (!url) return <span className="photo-thumb empty" style={box} aria-hidden="true" />;
  // Di dalam tombol lain (mis. item etalase) jangan jadi tombol bersarang: tampilkan gambar biasa.
  if (!zoom) {
    return (
      <span className="photo-thumb" style={box}>
        <img src={url} alt="" />
      </span>
    );
  }
  return (
    <>
      <button type="button" className="photo-thumb" style={box} onClick={() => zoom && setOpen(true)} aria-label={alt}>
        <img src={url} alt="" />
      </button>
      {open && (
        <Modal title={alt} onClose={() => setOpen(false)}>
          <img src={url} alt={alt} className="photo-full" />
        </Modal>
      )}
    </>
  );
}
