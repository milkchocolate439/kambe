// Kecilkan foto di perangkat sebelum dienkripsi & diunggah: JPEG, sisi terpanjang ≤ 1280 px, ≤ ±380 KB.
// Metadata asli (EXIF: lokasi, model HP) ikut terbuang karena gambar digambar ulang lewat canvas.

const MAX_SIDE = 1280;
const TARGET_BYTES = 380 * 1024;

export async function compressImage(source: Blob | HTMLCanvasElement): Promise<Uint8Array<ArrayBuffer>> {
  let canvas: HTMLCanvasElement;
  if (source instanceof HTMLCanvasElement) {
    canvas = source;
  } else {
    const bmp = await createImageBitmap(source);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
  }
  for (const q of [0.82, 0.7, 0.58, 0.45, 0.35]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
    if (!blob) break;
    if (blob.size <= TARGET_BYTES || q === 0.35) return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error("Foto tidak bisa diproses");
}

/** Gambar dari video kamera ke canvas (ukuran dibatasi MAX_SIDE). */
export function frameToCanvas(video: HTMLVideoElement): HTMLCanvasElement {
  const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(video.videoWidth * scale);
  c.height = Math.round(video.videoHeight * scale);
  c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
  return c;
}
