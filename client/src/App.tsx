import { useCallback, useEffect, useState } from "react";
import type { Me } from "../../shared/protocol.ts";
import { api, ApiError } from "./lib/api.ts";
import { createFresh, lockDevice, openDevice } from "./lib/device.ts";
import type { UnlockedDevice } from "./lib/keystore.ts";
import { Messenger } from "./lib/messenger.ts";
import { WIPED_HASH, WIPED_SERVER_HASH } from "./lib/panic.ts";
import { Auth, type AuthKind } from "./ui/Auth.tsx";
import { MessengerContext } from "./ui/common.tsx";
import { Shell } from "./ui/Shell.tsx";
import { DeviceSetup, SeedCodeScreen } from "./ui/Vault.tsx";

const SIGNED_OUT_NOTICE: Record<string, string> = {
  logout: "Kamu sudah keluar. Brankas di perangkat ini terkunci.",
  logout_all: "Kamu sudah keluar dari semua perangkat.",
  deleted: "Akunmu sudah dihapus permanen.",
  recovered: "Akun dipulihkan dari perangkat lain. Silakan masuk lagi dengan passphrase baru.",
  session_expired: "Sesi berakhir. Silakan masuk lagi.",
  locked: "Brankas enkripsi di perangkat ini terkunci. Masuk lagi untuk membukanya.",
};

const STORAGE_BLOCKED = "Browser ini tidak mengizinkan penyimpanan kunci enkripsi (mode privat/penyimpanan diblokir). Buka KAMBE di browser biasa.";

type Phase =
  | { t: "loading" }
  | { t: "auth"; notice: string | null; alias?: string }
  | { t: "device"; me: Me; passphrase: string; reason: "new_device" | "passphrase_changed" | "legacy" }
  | { t: "seed"; me: Me; device: UnlockedDevice; code: string }
  | { t: "ready"; messenger: Messenger }
  | { t: "error"; message: string };

export function App() {
  const [phase, setPhase] = useState<Phase>({ t: "loading" });

  const signedOut = useCallback((reason: string) => {
    setPhase((p) => {
      if (p.t === "ready") {
        p.messenger.stop();
        // Keluar = kunci brankas: kunci yang terbuka dihapus dari perangkat ini.
        if (reason !== "deleted") void lockDevice(p.messenger.getState().me.id).catch(() => {});
      }
      return { t: "auth", notice: SIGNED_OUT_NOTICE[reason] ?? null };
    });
  }, []);

  const enter = useCallback(
    async (me: Me, device: UnlockedDevice, justSetUp: boolean) => {
      const messenger = new Messenger(me, device, justSetUp, signedOut);
      try {
        await messenger.start();
        setPhase({ t: "ready", messenger });
      } catch (e) {
        messenger.stop();
        setPhase({ t: "error", message: e instanceof ApiError ? e.message : STORAGE_BLOCKED });
      }
    },
    [signedOut],
  );

  /** Keluar tanpa sempat membuka brankas (mis. batal di layar perangkat baru). */
  const abandon = useCallback(async (notice: string, alias?: string) => {
    await api("POST", "/api/auth/logout").catch(() => {});
    setPhase({ t: "auth", notice, alias });
  }, []);

  const afterAuth = useCallback(
    async (me: Me, passphrase: string, kind: AuthKind) => {
      setPhase({ t: "loading" });
      try {
        if (kind === "signup") {
          const r = await createFresh(me, passphrase);
          setPhase({ t: "seed", me, device: r.device, code: r.seedCode });
          return;
        }
        const o = await openDevice(me, passphrase);
        if (o.t === "ready") await enter(me, o.device, o.justSetUp);
        else if (o.t === "setup") setPhase({ t: "device", me, passphrase, reason: o.reason });
        else setPhase({ t: "auth", notice: SIGNED_OUT_NOTICE.locked, alias: me.alias });
      } catch {
        setPhase({ t: "error", message: STORAGE_BLOCKED });
      }
    },
    [enter],
  );

  const boot = useCallback(async () => {
    setPhase({ t: "loading" });
    // Setelah Panic Wipe: tampilkan pemberitahuan sekali lalu bersihkan penanda dari URL.
    const wiped = location.hash === WIPED_HASH ? "Semua jejak KAMBE di perangkat ini sudah dihapus." : location.hash === WIPED_SERVER_HASH ? "Akunmu dan semua jejak di perangkat ini sudah dihapus." : null;
    if (wiped) history.replaceState(null, "", location.pathname);
    let me: Me;
    try {
      ({ me } = await api<{ me: Me }>("GET", "/api/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setPhase({ t: "auth", notice: wiped });
      else setPhase({ t: "error", message: e instanceof Error ? e.message : "Gagal memuat" });
      return;
    }
    try {
      const o = await openDevice(me, null);
      if (o.t === "ready") await enter(me, o.device, o.justSetUp);
      else await abandon(SIGNED_OUT_NOTICE.locked, me.alias); // perlu passphrase untuk membuka brankas
    } catch {
      setPhase({ t: "error", message: STORAGE_BLOCKED });
    }
  }, [enter, abandon]);

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
          <strong>Tidak bisa membuka KAMBE</strong>
          <span className="small muted">{phase.message}</span>
          <button className="btn primary" onClick={() => void boot()}>
            Coba lagi
          </button>
        </div>
      </div>
    );
  }
  if (phase.t === "auth") return <Auth onAuthed={(me, pass, kind) => void afterAuth(me, pass, kind)} notice={phase.notice} initialAlias={phase.alias} />;
  if (phase.t === "device") {
    return (
      <DeviceSetup
        me={phase.me}
        passphrase={phase.passphrase}
        reason={phase.reason}
        onReady={(device, code) => (code ? setPhase({ t: "seed", me: phase.me, device, code }) : void enter(phase.me, device, true))}
        onCancel={() => void lockDevice(phase.me.id).then(() => abandon("Kamu sudah keluar.", phase.me.alias))}
      />
    );
  }
  if (phase.t === "seed") return <SeedCodeScreen code={phase.code} onDone={() => void enter(phase.me, phase.device, true)} />;
  return (
    <MessengerContext.Provider value={phase.messenger}>
      <Shell onSignedOut={signedOut} />
    </MessengerContext.Provider>
  );
}
