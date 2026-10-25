import { useCallback, useEffect, useState } from "react";
import type { Me } from "../../shared/protocol.ts";
import { api, ApiError } from "./lib/api.ts";
import { Messenger } from "./lib/messenger.ts";
import { Auth } from "./ui/Auth.tsx";
import { MessengerContext } from "./ui/common.tsx";
import { Shell } from "./ui/Shell.tsx";

const SIGNED_OUT_NOTICE: Record<string, string> = {
  logout: "Kamu sudah keluar.",
  logout_all: "Kamu sudah keluar dari semua perangkat.",
  deleted: "Akunmu sudah dihapus permanen.",
  recovered: "Akun dipulihkan dari perangkat lain. Silakan masuk lagi dengan passphrase baru.",
  session_expired: "Sesi berakhir. Silakan masuk lagi.",
};

type Phase = { t: "loading" } | { t: "auth"; notice: string | null } | { t: "ready"; messenger: Messenger } | { t: "error"; message: string };

export function App() {
  const [phase, setPhase] = useState<Phase>({ t: "loading" });

  const signedOut = useCallback((reason: string) => {
    setPhase((p) => {
      if (p.t === "ready") p.messenger.stop();
      return { t: "auth", notice: SIGNED_OUT_NOTICE[reason] ?? null };
    });
  }, []);

  const enter = useCallback(
    async (me: Me) => {
      const messenger = new Messenger(me, signedOut);
      try {
        await messenger.start();
        setPhase({ t: "ready", messenger });
      } catch (e) {
        messenger.stop();
        setPhase({
          t: "error",
          message:
            e instanceof ApiError
              ? e.message
              : "Browser ini tidak mengizinkan penyimpanan kunci enkripsi (mode privat/penyimpanan diblokir). Buka PINPath di browser biasa.",
        });
      }
    },
    [signedOut],
  );

  const boot = useCallback(async () => {
    setPhase({ t: "loading" });
    try {
      const { me } = await api<{ me: Me }>("GET", "/api/me");
      await enter(me);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setPhase({ t: "auth", notice: null });
      else setPhase({ t: "error", message: e instanceof Error ? e.message : "Gagal memuat" });
    }
  }, [enter]);

  useEffect(() => {
    void boot();
  }, [boot]);

  if (phase.t === "loading") {
    return (
      <div className="auth">
        <div className="muted small">Membuka brankas enkripsi…</div>
      </div>
    );
  }
  if (phase.t === "error") {
    return (
      <div className="auth">
        <div className="card auth-card stack">
          <strong>Tidak bisa membuka PINPath</strong>
          <span className="small muted">{phase.message}</span>
          <button className="btn primary" onClick={() => void boot()}>
            Coba lagi
          </button>
        </div>
      </div>
    );
  }
  if (phase.t === "auth") return <Auth onAuthed={(me) => void enter(me)} notice={phase.notice} />;
  return (
    <MessengerContext.Provider value={phase.messenger}>
      <Shell onSignedOut={signedOut} />
    </MessengerContext.Provider>
  );
}
