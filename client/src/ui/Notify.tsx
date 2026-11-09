// Tombol lonceng (topbar) & sakelar (Profil) untuk popup notifikasi Web Push.
import { useEffect, useState } from "react";
import { disablePush, enablePush, pushState, type PushState } from "../lib/push.ts";
import { ApiError } from "../lib/api.ts";
import { Switch, useMessenger } from "./common.tsx";
import { Icon } from "./icons.tsx";

function usePush() {
  const [, m] = useMessenger();
  const [state, setState] = useState<PushState>("unsupported");
  useEffect(() => {
    void pushState().then(setState, () => setState("unsupported"));
  }, []);
  async function toggle(on: boolean) {
    try {
      if (on) {
        const s = await enablePush();
        setState(s);
        if (s === "denied") m.toast("Notifikasi diblokir di pengaturan browser", "warn");
      } else {
        await disablePush();
        setState("off");
      }
    } catch (e) {
      m.toast(e instanceof ApiError ? e.message : "Notifikasi tidak bisa diaktifkan", "warn");
    }
  }
  return { state, toggle };
}

export function NotifyButton() {
  const { state, toggle } = usePush();
  if (state === "unsupported") return null;
  const on = state === "on";
  return (
    <button className={`btn ghost icon ${on ? "" : "notify-off"}`} aria-label="Notifikasi" aria-pressed={on} title="Notifikasi" onClick={() => void toggle(!on)}>
      <Icon name={on ? "bell" : "bellOff"} />
    </button>
  );
}

export function NotifySwitch() {
  const { state, toggle } = usePush();
  if (state === "unsupported") return null;
  return (
    <div className="row">
      <div className="grow" style={{ fontWeight: 600 }}>Popup notifikasi</div>
      <Switch checked={state === "on"} label="Popup notifikasi" onChange={(v) => void toggle(v)} />
    </div>
  );
}
