import type { ClientEvent, ServerEvent } from "../../../shared/protocol.ts";

export type ConnState = "connecting" | "online" | "offline";

/**
 * WebSocket yang menyambung ulang sendiri (backoff bertahap + jitter) dan
 * berhenti total bila sesi dicabut server (logout / akun dihapus).
 */
export class Realtime {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  state: ConnState = "offline";

  private readonly onEvent: (ev: ServerEvent) => void;
  private readonly onState: (s: ConnState) => void;
  private readonly onSessionEnded: (reason: string) => void;

  constructor(onEvent: (ev: ServerEvent) => void, onState: (s: ConnState) => void, onSessionEnded: (reason: string) => void) {
    this.onEvent = onEvent;
    this.onState = onState;
    this.onSessionEnded = onSessionEnded;
  }

  start() {
    this.stopped = false;
    this.connect();
    window.addEventListener("online", this.wake);
    document.addEventListener("visibilitychange", this.wake);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    window.removeEventListener("online", this.wake);
    document.removeEventListener("visibilitychange", this.wake);
    this.ws?.close();
    this.ws = null;
    this.setState("offline");
  }

  send(ev: ClientEvent): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(ev));
    return true;
  }

  private wake = () => {
    if (!this.stopped && document.visibilityState === "visible" && this.state === "offline") {
      if (this.timer) clearTimeout(this.timer);
      this.attempt = 0;
      this.connect();
    }
  };

  private setState(s: ConnState) {
    this.state = s;
    this.onState(s);
  }

  private connect() {
    if (this.stopped) return;
    this.setState("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setState("online");
    };
    ws.onmessage = (e) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(String(e.data)) as ServerEvent;
      } catch {
        return;
      }
      if (ev.t === "session_ended") {
        this.stopped = true;
        this.onSessionEnded(ev.reason);
        return;
      }
      this.onEvent(ev);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setState("offline");
      if (e.code === 4001) {
        this.stopped = true;
        this.onSessionEnded("session_expired");
        return;
      }
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt++) * (0.7 + Math.random() * 0.6);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }
}
