// Bunyi khas KAMBE: "SSSSSTTT!!" — desisan panjang lalu dua ketukan "T" yang tajam.
// Disintesis langsung dengan Web Audio (tanpa berkas audio): derau putih → saring pita (desis "S")
// lalu dua ledakan pendek bertapis tinggi ("T T"). Getaran ikut berpola sama di HP.

let ctx: AudioContext | null = null;
let played = 0;
const KEY = "kambe:sound";

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* penyimpanan diblokir */
  }
}

/** Browser hanya mengizinkan suara setelah interaksi pengguna: panggil sekali saat sentuhan pertama. */
export function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    /* tanpa Web Audio */
  }
}

function noise(c: AudioContext, seconds: number): AudioBuffer {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

export const SST_VIBRATE = [40, 25, 40, 25, 40, 25, 220];

/** Bunyikan "SSSSSTTT!!". Mengembalikan true bila dimainkan. */
export function playSst(force = false): boolean {
  if (!force && !soundEnabled()) return false;
  try {
    ctx ??= new AudioContext();
    const c = ctx;
    if (c.state === "suspended") void c.resume();
    const t0 = c.currentTime + 0.02;

    // "SSSSS": desis yang naik sedikit nadanya, ±0,55 detik.
    const hissSrc = c.createBufferSource();
    hissSrc.buffer = noise(c, 0.65);
    const band = c.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 0.9;
    band.frequency.setValueAtTime(4800, t0);
    band.frequency.linearRampToValueAtTime(7400, t0 + 0.55);
    const hiss = c.createGain();
    hiss.gain.setValueAtTime(0.0001, t0);
    hiss.gain.exponentialRampToValueAtTime(0.32, t0 + 0.07);
    hiss.gain.setValueAtTime(0.32, t0 + 0.48);
    hiss.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
    hissSrc.connect(band).connect(hiss).connect(c.destination);
    hissSrc.start(t0);
    hissSrc.stop(t0 + 0.65);

    // "T T": dua ketukan tajam.
    for (const at of [0.68, 0.82]) {
      const s = c.createBufferSource();
      s.buffer = noise(c, 0.06);
      const hp = c.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 2600;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.55, t0 + at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.045);
      s.connect(hp).connect(g).connect(c.destination);
      s.start(t0 + at);
      s.stop(t0 + at + 0.06);
    }
    navigator.vibrate?.(SST_VIBRATE);
    played++;
    document.documentElement.dataset.sst = String(played); // penanda untuk uji otomatis
    return true;
  } catch {
    return false;
  }
}
