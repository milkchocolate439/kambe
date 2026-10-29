// Fase 3 — PIN Bayang (Shadow PIN) & Radar Arwah (radar ekonomi, opt-in).
import { useEffect, useState } from "react";
import { MAX_ACTIVE_ONCE, MAX_ACTIVE_SHADOW, RADAR_HEADLINE_MAX, SECTORS, type LabelContent } from "../../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { copyText, Modal, SealedText, timeOf, useMessenger } from "./common.tsx";
import { Icon } from "./icons.tsx";

function remaining(ts: number) {
  const ms = ts - Date.now();
  if (ms <= 0) return "kedaluwarsa";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 24) return `${Math.round(ms / 86_400_000)} hari lagi`; // 6,99 hari tampil "7 hari", bukan "6"
  if (h >= 1) return `${h} jam lagi`;
  return `${Math.max(1, Math.round(ms / 60_000))} menit lagi`;
}

// --------------------------------------------------------------- Shadow ---

export function ShadowPinModal({ onClose }: { onClose: () => void }) {
  const [s, m] = useMessenger();
  const [label, setLabel] = useState("");
  const [once, setOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pins = s.shadowPins?.filter((p) => p.kind === "shadow" || p.kind === "once") ?? null;
  const activeOfKind = pins?.filter((p) => p.kind === (once ? "once" : "shadow")).length ?? 0;

  useEffect(() => {
    void m.loadShadowPins().catch(() => setError("Gagal memuat PIN Bayang"));
  }, [m]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (ok) m.toast(ok, "ok");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="PIN Bayang" onClose={onClose}>
      <div className="stack">
        <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>
          PIN sementara (24 jam) untuk dibagikan ke orang asing — misalnya di grup jual-beli. Orang yang terhubung lewat PIN Bayang <strong>tidak pernah melihat PIN Kambe utamamu</strong>. Cabut kapan saja; undangan yang belum kamu terima ikut hangus.
        </p>
        {pins === null ? (
          <div className="hint">Memuat…</div>
        ) : pins.length === 0 ? (
          <div className="hint">Belum ada PIN Bayang aktif.</div>
        ) : (
          <div className="list">
            {pins.map((p) => (
              <div key={p.pin} className="row" style={{ padding: "8px 4px", borderBottom: "1px solid var(--line)" }}>
                <button className="pin-big" style={{ fontSize: 20, background: "none", border: 0, padding: 0 }} onClick={async () => (await copyText(p.pin)) && m.toast(`PIN Bayang ${p.pin} disalin`, "ok")} aria-label={`Salin PIN Bayang ${p.pin}`}>
                  {p.pin}
                </button>
                <div className="grow">
                  <div className="row" style={{ gap: 6 }}>
                    {p.kind === "once" && <span className="badge warn">SEKALI PAKAI</span>}
                    {p.label && (
                      <span className="small truncate" style={{ fontWeight: 700 }}>
                        <SealedText<LabelContent> view={p.label} field="text" max={40} />
                      </span>
                    )}
                  </div>
                  <div className="tiny muted">Mati {remaining(p.expiresAt)} ({timeOf(p.expiresAt)}){p.kind === "once" ? " atau setelah dipakai sekali" : ""}</div>
                </div>
                <button className="btn small danger" disabled={busy} onClick={() => void run(() => m.revokeShadowPin(p.pin), `PIN Bayang ${p.pin} dicabut`)}>
                  Cabut
                </button>
              </div>
            ))}
          </div>
        )}
        {pins && (
          <div className="stack" style={{ gap: 8 }}>
            <label className="row small" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} />
              <span>
                <strong>Sekali pakai</strong> — hangus otomatis setelah dipakai satu orang (cocok untuk dikirim ke satu calon pembeli)
              </span>
            </label>
            <div className="row">
              <input className="input grow" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (opsional), mis. Grup FB Rotan" aria-label="Label PIN Bayang" />
              <button
                className="btn primary"
                disabled={busy || activeOfKind >= (once ? MAX_ACTIVE_ONCE : MAX_ACTIVE_SHADOW)}
                onClick={() =>
                  void run(async () => {
                    const p = await m.createShadowPin(label.trim(), once);
                    setLabel("");
                    if (await copyText(p.pin)) m.toast(`${once ? "PIN sekali pakai" : "PIN Bayang"} ${p.pin} dibuat & disalin`, "ok");
                  })
                }
              >
                <Icon name="plus" /> Buat
              </button>
            </div>
          </div>
        )}
        <span className="hint">
          Maksimal {MAX_ACTIVE_SHADOW} PIN Bayang dan {MAX_ACTIVE_ONCE} PIN sekali pakai aktif sekaligus.
        </span>
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Radar ---

export function RadarCard() {
  const [s, m] = useMessenger();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sector, setSector] = useState<string>(SECTORS[0]);
  const [headline, setHeadline] = useState("");
  const [filter, setFilter] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mine = s.myRadar;

  useEffect(() => {
    if (open && mine === undefined) void m.loadMyRadar().catch(() => {});
  }, [open, mine, m]);
  useEffect(() => {
    if (open && mine) void m.loadRadar(filter || null).catch((e) => setError(e instanceof ApiError ? e.message : "Gagal memuat Radar Arwah"));
  }, [open, mine, filter, m]);

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      if (ok) m.toast(ok, "ok");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <button className="row" style={{ width: "100%", background: "none", border: 0, padding: 0, textAlign: "left" }} onClick={() => setOpen(!open)} aria-expanded={open}>
        <h3 style={{ margin: 0 }} className="grow">
          <Icon name="store" size={14} /> Radar Arwah
        </h3>
        <span className={`badge ${mine ? "ok" : ""}`}>{mine ? "Aktif" : "Mati"}</span>
      </button>
      {open && (
        <div className="stack" style={{ marginTop: 10 }}>
          {mine === undefined ? (
            <div className="hint">Memuat…</div>
          ) : !mine || editing ? (
            <>
              {!mine && (
                <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>
                  Temukan mitra dagang sesuai sektor. <strong>Hanya sesama peserta Radar Arwah</strong> yang bisa melihatmu, yang tampil adalah <strong>PIN radar khusus</strong> (bukan PIN utama), dan kamu hilang dari radar otomatis setelah 7 hari. Undangan tetap harus kamu setujui.
                </p>
              )}
              <select className="input" value={sector} onChange={(e) => setSector(e.target.value)} aria-label="Sektor radar">
                {SECTORS.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              <input className="input" maxLength={RADAR_HEADLINE_MAX} value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Apa yang kamu cari / tawarkan? (min. 10 karakter)" aria-label="Kebutuhan atau tawaran" />
              <div className="row">
                {editing && <button className="btn grow" onClick={() => setEditing(false)}>Batal</button>}
                <button
                  className="btn primary grow"
                  disabled={busy !== null || headline.trim().length < 10}
                  onClick={() =>
                    void run("join", async () => {
                      await m.joinRadar(sector, headline.trim());
                      setEditing(false);
                    }, mine ? "Radar Arwah diperbarui (7 hari)" : "Kamu tampil di Radar Arwah selama 7 hari")
                  }
                >
                  {mine ? "Simpan & perpanjang" : "Ikut Radar Arwah 7 hari"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="small" style={{ color: "var(--text-2)" }}>
                Tampil sebagai <strong>{mine.headline}</strong> · {mine.sector}
                <br />
                PIN radar <span className="badge pin">{mine.pin}</span> · mati {remaining(mine.expiresAt)}
              </div>
              <div className="row">
                <button className="btn small grow" onClick={() => { setSector(mine.sector); setHeadline(mine.headline); setEditing(true); }}>Ubah / perpanjang</button>
                <button className="btn small danger grow" disabled={busy !== null} onClick={() => void run("leave", () => m.leaveRadar(), "Kamu keluar dari Radar Arwah. PIN radar dimatikan.")}>
                  Keluar Radar Arwah
                </button>
              </div>
              <div className="divider" />
              <div className="row">
                <select className="input grow" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter sektor">
                  <option value="">Semua sektor</option>
                  {SECTORS.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                <button className="btn ghost icon" onClick={() => void m.loadRadar(filter || null).catch(() => {})} aria-label="Acak ulang Radar Arwah" title="Acak ulang">
                  <Icon name="refresh" />
                </button>
              </div>
              {s.radarEntries === null ? (
                <div className="hint">Memuat…</div>
              ) : s.radarEntries.length === 0 ? (
                <div className="hint">Belum ada peserta lain di sektor ini.</div>
              ) : (
                <div className="list">
                  {s.radarEntries.map((e) => (
                    <div key={e.pin} className="stack" style={{ gap: 4, padding: 10, borderRadius: 12, background: "var(--panel-2)" }}>
                      <div className="row" style={{ gap: 6 }}>
                        <strong className="truncate grow">{e.alias}</strong>
                        {e.pro && <span className="badge warn">ETALASE</span>}
                        <span className="badge pin">{e.pin}</span>
                      </div>
                      <div className="small" style={{ color: "var(--text-2)" }}>{e.headline}</div>
                      <div className="row">
                        <span className="tiny muted grow">{e.sector}</span>
                        <button
                          className="btn small primary"
                          disabled={busy !== null}
                          onClick={() => void run(e.pin, () => m.invite(e.pin, `Dari Radar Arwah: ${mine.headline}`.slice(0, 120)), `Undangan terkirim ke ${e.alias}`)}
                        >
                          <Icon name="userPlus" size={14} /> Undang
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {error && <span className="error" role="alert">{error}</span>}
        </div>
      )}
    </section>
  );
}
