import {
  decryptPayload,
  deriveConversationKey,
  E2EEError,
  encryptPayload,
  generateIdentity,
  safetyNumber,
  type Envelope,
  type Identity,
  type Payload,
} from "../../../shared/e2ee.ts";
import {
  PING_COOLDOWN_MS,
  type ClientEvent,
  type Contact,
  type ContactsResponse,
  type Deal,
  type DealAction,
  type IncomingRequest,
  type Me,
  type OutgoingRequest,
  type Product,
  type ProStatus,
  type ServerEvent,
  type StoredMessage,
  type Wallet,
} from "../../../shared/protocol.ts";
import { api, ApiError } from "./api.ts";
import { keystore, type PinnedKey } from "./keystore.ts";
import { Realtime, type ConnState } from "./realtime.ts";

export type MsgStatus = "pending" | "S" | "D" | "R" | "failed";

export interface ChatMessage {
  id: string;
  mine: boolean;
  /** locked = terenkripsi untuk perangkat lain; broken = gagal dibuka/diubah di jalan */
  kind: "text" | "ping" | "identity" | "locked" | "broken";
  text: string;
  createdAt: number;
  status: MsgStatus;
  error?: string;
  /** Kunci pengirim bukan kunci yang kita pin — kemungkinan penyusupan. */
  untrusted?: boolean;
}

export interface Thread {
  messages: ChatMessage[];
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "ok" | "warn" | "danger";
}

export interface State {
  me: Me;
  device: "setting_up" | "ok" | "other_device";
  conn: ConnState;
  contacts: Contact[];
  incoming: IncomingRequest[];
  outgoing: OutgoingRequest[];
  pins: Record<string, PinnedKey>;
  keyAlerts: Record<string, string>; // peerId -> kunci baru yang belum diakui
  threads: Record<string, Thread>;
  activePeer: string | null;
  ping: { peer: string; at: number } | null;
  toasts: Toast[];
  // Fase 2 — dagang (SIMULASI)
  pro: ProStatus | null;
  myProducts: Product[];
  catalogs: Record<string, { pro: boolean; products: Product[] }>;
  deals: Record<string, Deal[]>;
  wallet: Wallet | null;
}

const RANK: Record<MsgStatus, number> = { failed: -1, pending: 0, S: 1, D: 2, R: 3 };

export class Messenger {
  private state: State;
  private listeners = new Set<() => void>();
  private identity: Identity | null = null;
  private keyCache = new Map<string, Promise<CryptoKey>>();
  private outbox = new Map<string, ClientEvent & { t: "send" }>();
  private readSent = new Set<string>();
  private lastPingSent = new Map<string, number>();
  private lastPingShown = new Map<string, number>();
  private toastSeq = 0;
  private rt: Realtime;
  private readonly onSignedOut: (reason: string) => void;

  constructor(me: Me, onSignedOut: (reason: string) => void) {
    this.onSignedOut = onSignedOut;
    this.state = {
      me,
      device: "setting_up",
      conn: "offline",
      contacts: [],
      incoming: [],
      outgoing: [],
      pins: {},
      keyAlerts: {},
      threads: {},
      activePeer: null,
      ping: null,
      toasts: [],
      pro: null,
      myProducts: [],
      catalogs: {},
      deals: {},
      wallet: null,
    };
    this.rt = new Realtime(
      (ev) => void this.onEvent(ev),
      (conn) => {
        this.set({ conn });
        if (conn === "online") this.onOnline();
      },
      (reason) => this.onSignedOut(reason),
    );
  }

  // ------------------------------------------------------- store dasar ---

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.state;

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private setThread(peer: string, fn: (t: Thread) => Thread) {
    const cur = this.state.threads[peer] ?? { messages: [], loaded: false, loading: false, hasMore: false };
    this.set({ threads: { ...this.state.threads, [peer]: fn(cur) } });
  }

  toast(text: string, tone: Toast["tone"] = "info") {
    const id = ++this.toastSeq;
    this.set({ toasts: [...this.state.toasts, { id, text, tone }].slice(-3) });
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) }), tone === "danger" ? 7000 : 4200);
  }

  // ----------------------------------------------------------- siklus ---

  async start() {
    await this.setupDevice();
    this.rt.start();
    await Promise.all([this.refreshContacts(), this.loadMyStore()]);
    document.addEventListener("visibilitychange", this.onVisible);
  }

  stop() {
    this.rt.stop();
    document.removeEventListener("visibilitychange", this.onVisible);
  }

  private onVisible = () => {
    if (document.visibilityState === "visible" && this.state.activePeer) this.markRead(this.state.activePeer);
  };

  /** Siapkan kunci perangkat. Kunci privat dibuat DI SINI dan tidak pernah dikirim. */
  private async setupDevice() {
    const me = this.state.me;
    let local = (await keystore.getIdentity(me.id)) ?? null;
    if (local && me.publicKey && local.publicKey !== me.publicKey) {
      this.identity = local;
      this.set({ device: "other_device" });
      return;
    }
    if (!local) {
      local = await generateIdentity();
      await keystore.putIdentity(me.id, local);
      if (me.publicKey) this.toast("Perangkat baru terdaftar. Pesan lama dari perangkat sebelumnya tidak bisa dibuka di sini.", "warn");
    }
    this.identity = local;
    if (me.publicKey !== local.publicKey) {
      const { me: updated } = await api<{ me: Me }>("PUT", "/api/me/key", { publicKey: local.publicKey });
      this.set({ me: updated });
    }
    this.set({ device: "ok" });
  }

  /** Pakai kembali perangkat ini setelah akun sempat aktif di perangkat lain. */
  async reclaimDevice() {
    const fresh = await generateIdentity();
    const { me } = await api<{ me: Me }>("PUT", "/api/me/key", { publicKey: fresh.publicKey });
    await keystore.putIdentity(me.id, fresh);
    this.identity = fresh;
    this.keyCache.clear();
    this.set({ me, device: "ok", threads: {} });
    if (this.state.activePeer) await this.loadThread(this.state.activePeer);
    this.toast("Perangkat ini aktif lagi. Kontakmu akan melihat safety number baru.", "ok");
  }

  private onOnline() {
    // Kirim ulang pesan yang tertahan saat offline (id sama → server tidak menggandakan).
    for (const ev of this.outbox.values()) this.rt.send(ev);
    void this.refreshContacts();
    for (const peer of Object.keys(this.state.threads)) if (this.state.threads[peer].loaded) void this.loadThread(peer);
  }

  // ----------------------------------------------------------- kontak ---

  async refreshContacts() {
    let data: ContactsResponse;
    try {
      data = await api<ContactsResponse>("GET", "/api/contacts");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.onSignedOut("session_expired");
      return;
    }
    const me = this.state.me.id;
    const pins = { ...this.state.pins };
    const keyAlerts: Record<string, string> = {};
    for (const c of data.contacts) {
      if (!c.publicKey) continue;
      let pin = pins[c.id] ?? (await keystore.getPin(me, c.id));
      if (!pin) {
        // Trust On First Use: kunci pertama yang terlihat dipercaya, perubahan berikutnya diperingatkan.
        pin = { publicKey: c.publicKey, verified: false, firstSeen: Date.now() };
        await keystore.putPin(me, c.id, pin);
      }
      pins[c.id] = pin;
      if (pin.publicKey !== c.publicKey) keyAlerts[c.id] = c.publicKey;
    }
    // Pertahankan unread=0 untuk percakapan yang sedang dibuka.
    const contacts = data.contacts.map((c) => (c.id === this.state.activePeer && document.visibilityState === "visible" ? { ...c, unread: 0 } : c));
    this.set({ contacts, incoming: data.incoming, outgoing: data.outgoing, pins, keyAlerts });
    if (this.state.activePeer && !contacts.some((c) => c.id === this.state.activePeer)) this.set({ activePeer: null });
  }

  contact(peer: string) {
    return this.state.contacts.find((c) => c.id === peer);
  }

  async invite(pin: string, note: string) {
    const r = await api<{ status: "pending" | "connected" }>("POST", "/api/contacts/invite", { pin, note });
    await this.refreshContacts();
    return r.status;
  }

  async respond(requestId: string, accept: boolean) {
    const data = await api<ContactsResponse>("POST", `/api/contacts/requests/${requestId}/${accept ? "accept" : "decline"}`);
    this.set({ incoming: data.incoming });
    await this.refreshContacts();
  }

  async cancelRequest(requestId: string) {
    await api("DELETE", `/api/contacts/requests/${requestId}`);
    await this.refreshContacts();
  }

  async removeContact(peer: string) {
    await api("DELETE", `/api/contacts/${peer}`);
    if (this.state.activePeer === peer) this.set({ activePeer: null });
    await this.refreshContacts();
  }

  async block(userId: string) {
    await api("POST", "/api/blocks", { userId });
    if (this.state.activePeer === userId) this.set({ activePeer: null });
    await this.refreshContacts();
  }

  async acknowledgeKeyChange(peer: string) {
    const key = this.state.keyAlerts[peer];
    if (!key) return;
    const pin: PinnedKey = { publicKey: key, verified: false, firstSeen: Date.now() };
    await keystore.putPin(this.state.me.id, peer, pin);
    const { [peer]: _, ...rest } = this.state.keyAlerts;
    this.set({ pins: { ...this.state.pins, [peer]: pin }, keyAlerts: rest });
    void this.loadThread(peer);
  }

  async setVerified(peer: string, verified: boolean) {
    const pin = this.state.pins[peer];
    if (!pin) return;
    const next = { ...pin, verified };
    await keystore.putPin(this.state.me.id, peer, next);
    this.set({ pins: { ...this.state.pins, [peer]: next } });
  }

  async safetyNumberFor(peer: string): Promise<string | null> {
    const c = this.contact(peer);
    const myKey = this.identity?.publicKey;
    if (!c?.publicKey || !myKey) return null;
    return safetyNumber({ id: this.state.me.id, publicKey: myKey }, { id: c.id, publicKey: c.publicKey });
  }

  // ---------------------------------------------------------- profil ---

  async updateSettings(patch: { pm?: string; readReceipts?: boolean }) {
    const { me } = await api<{ me: Me }>("PATCH", "/api/me/settings", patch);
    this.set({ me });
  }

  async rotatePin() {
    const { me } = await api<{ me: Me }>("POST", "/api/me/pin/rotate");
    this.set({ me });
    return me.pin;
  }

  // ------------------------------------------------------------ pesan ---

  private conversationKey(myKey: string, peer: string, peerKey: string): Promise<CryptoKey> {
    const id = `${myKey}|${peer}|${peerKey}`;
    let k = this.keyCache.get(id);
    if (!k) {
      k = deriveConversationKey(this.identity!.privateKey, { id: this.state.me.id, publicKey: myKey }, { id: peer, publicKey: peerKey });
      this.keyCache.set(id, k);
      k.catch(() => this.keyCache.delete(id));
    }
    return k;
  }

  private async decrypt(m: StoredMessage): Promise<ChatMessage> {
    const meId = this.state.me.id;
    const mine = m.from === meId;
    const peer = mine ? m.to : m.from;
    const myKey = mine ? m.fromKey : m.toKey;
    const peerKey = mine ? m.toKey : m.fromKey;
    const base = { id: m.id, mine, createdAt: m.createdAt, status: m.status as MsgStatus };
    if (!this.identity || myKey !== this.identity.publicKey) {
      return { ...base, kind: m.ping ? "ping" : "locked", text: "" };
    }
    const pinned = this.state.pins[peer]?.publicKey;
    const untrusted = !mine && !!pinned && pinned !== peerKey;
    try {
      const env: Envelope = { id: m.id, from: { id: m.from, publicKey: m.fromKey }, to: { id: m.to, publicKey: m.toKey } };
      const p = await decryptPayload(await this.conversationKey(myKey, peer, peerKey), env, m.nonce, m.ciphertext);
      return { ...base, kind: p.kind, text: p.kind === "ping" ? "" : p.text, untrusted };
    } catch (e) {
      return { ...base, kind: "broken", text: "", error: e instanceof E2EEError ? e.message : "Pesan tidak bisa dibuka", untrusted };
    }
  }

  private upsert(peer: string, msg: ChatMessage) {
    this.setThread(peer, (t) => {
      const i = t.messages.findIndex((m) => m.id === msg.id);
      if (i < 0) return { ...t, messages: [...t.messages, msg].sort((a, b) => a.createdAt - b.createdAt) };
      const prev = t.messages[i];
      // Status hanya boleh naik (S→D→R), tidak turun karena event yang datang terlambat.
      const status = RANK[msg.status] >= RANK[prev.status] || prev.status === "failed" ? msg.status : prev.status;
      const messages = [...t.messages];
      messages[i] = { ...prev, ...msg, status };
      return { ...t, messages };
    });
  }

  private patchStatus(ids: string[], status: MsgStatus, error?: string) {
    const set = new Set(ids);
    const threads = { ...this.state.threads };
    let changed = false;
    for (const [peer, t] of Object.entries(threads)) {
      if (!t.messages.some((m) => set.has(m.id))) continue;
      threads[peer] = {
        ...t,
        messages: t.messages.map((m) =>
          set.has(m.id) && (status === "failed" || RANK[status] > RANK[m.status]) ? { ...m, status, error } : m,
        ),
      };
      changed = true;
    }
    if (changed) this.set({ threads });
  }

  async openThread(peer: string | null) {
    this.set({ activePeer: peer });
    if (!peer) return;
    void this.loadDeals(peer);
    if (!this.state.threads[peer]?.loaded) await this.loadThread(peer);
    this.markRead(peer);
  }

  // ------------------------------------------- dagang (Fase 2, SIMULASI) ---

  async loadMyStore() {
    try {
      const r = await api<{ pro: ProStatus; products: Product[] }>("GET", "/api/products/mine");
      this.set({ pro: r.pro, myProducts: r.products });
    } catch {
      /* tidak kritis untuk chat */
    }
  }

  async subscribePro(idempotencyKey: string) {
    const pro = await api<ProStatus>("POST", "/api/pro/subscribe", { idempotencyKey });
    this.set({ pro });
    void this.loadWallet();
    return pro;
  }

  async saveProduct(p: { id?: string; title: string; description: string; sector: string; price: number }) {
    const { id, ...body } = p;
    await api(id ? "PATCH" : "POST", id ? `/api/products/${id}` : "/api/products", body);
    await this.loadMyStore();
    return true;
  }

  async deleteProduct(id: string) {
    await api("DELETE", `/api/products/${id}`);
    await this.loadMyStore();
  }

  async loadCatalog(peer: string) {
    const r = await api<{ pro: boolean; products: Product[] }>("GET", `/api/users/${peer}/products`);
    this.set({ catalogs: { ...this.state.catalogs, [peer]: r } });
  }

  async loadDeals(peer: string) {
    try {
      const { deals } = await api<{ deals: Deal[] }>("GET", `/api/deals?peer=${encodeURIComponent(peer)}`);
      this.set({ deals: { ...this.state.deals, [peer]: deals } });
    } catch {
      /* diabaikan; dicoba lagi saat event berikutnya */
    }
  }

  private upsertDeal(peer: string, deal: Deal) {
    const list = this.state.deals[peer] ?? [];
    const next = list.some((d) => d.id === deal.id) ? list.map((d) => (d.id === deal.id ? deal : d)) : [...list, deal];
    this.set({ deals: { ...this.state.deals, [peer]: next } });
  }

  async createDeal(peer: string, productId: string, idempotencyKey: string) {
    const deal = await api<Deal>("POST", "/api/deals", { productId, idempotencyKey });
    this.upsertDeal(peer, deal);
    return deal;
  }

  async offerDeal(peer: string, title: string, price: number, idempotencyKey: string) {
    const deal = await api<Deal>("POST", "/api/deals/offer", { buyerId: peer, title, price, idempotencyKey });
    this.upsertDeal(peer, deal);
    return deal;
  }

  async dealAction(peer: string, dealId: string, action: DealAction) {
    const deal = await api<Deal>("POST", `/api/deals/${dealId}/${action}`);
    this.upsertDeal(peer, deal);
    if (this.state.wallet) void this.loadWallet();
    return deal;
  }

  async loadWallet() {
    try {
      this.set({ wallet: await api<Wallet>("GET", "/api/wallet") });
    } catch {
      /* diabaikan */
    }
  }

  /** Identitas asli dikirim sebagai pesan E2EE biasa — server tidak pernah melihat isinya. */
  shareIdentity(peer: string, text: string) {
    return this.send(peer, { kind: "identity", text });
  }

  async loadThread(peer: string) {
    this.setThread(peer, (t) => ({ ...t, loading: true }));
    try {
      const { messages, hasMore } = await api<{ messages: StoredMessage[]; hasMore: boolean }>("GET", `/api/messages/${peer}`);
      const decrypted = await Promise.all(messages.map((m) => this.decrypt(m)));
      this.setThread(peer, (t) => {
        const pending = t.messages.filter((m) => (m.status === "pending" || m.status === "failed") && !decrypted.some((d) => d.id === m.id));
        return { messages: [...decrypted, ...pending].sort((a, b) => a.createdAt - b.createdAt), loaded: true, loading: false, hasMore };
      });
      if (this.state.activePeer === peer) this.markRead(peer);
    } catch (e) {
      this.setThread(peer, (t) => ({ ...t, loading: false }));
      if (e instanceof ApiError && e.status !== 404) this.toast(e.message, "danger");
    }
  }

  private markRead(peer: string) {
    if (document.visibilityState !== "visible" || this.state.activePeer !== peer) return;
    const t = this.state.threads[peer];
    if (!t) return;
    const ids = t.messages.filter((m) => !m.mine && !this.readSent.has(m.id)).map((m) => m.id);
    if (ids.length && this.rt.send({ t: "read", peer, ids })) for (const id of ids) this.readSent.add(id);
    const c = this.contact(peer);
    if (c?.unread) this.set({ contacts: this.state.contacts.map((x) => (x.id === peer ? { ...x, unread: 0 } : x)) });
  }

  /** Alasan tidak boleh mengirim, atau null bila aman. */
  sendBlocker(peer: string): string | null {
    if (this.state.device !== "ok" || !this.identity) return "Perangkat ini belum aktif untuk akunmu";
    const c = this.contact(peer);
    if (!c) return "Kontak tidak ditemukan";
    if (!c.publicKey) return `${c.alias} belum pernah membuka PINPath di perangkatnya`;
    if (this.state.keyAlerts[peer]) return "Safety number berubah — tinjau dulu sebelum mengirim";
    return null;
  }

  async send(peer: string, payload: Payload): Promise<boolean> {
    const blocker = this.sendBlocker(peer);
    if (blocker) {
      this.toast(blocker, "warn");
      return false;
    }
    const isPing = payload.kind === "ping";
    if (isPing) {
      const last = this.lastPingSent.get(peer) ?? 0;
      const wait = PING_COOLDOWN_MS - (Date.now() - last);
      if (wait > 0) {
        this.toast(`PING!!! bisa dikirim lagi dalam ${Math.ceil(wait / 1000)} detik`, "warn");
        return false;
      }
      this.lastPingSent.set(peer, Date.now());
    }
    const c = this.contact(peer)!;
    const myKey = this.identity!.publicKey;
    const env: Envelope = { id: crypto.randomUUID(), from: { id: this.state.me.id, publicKey: myKey }, to: { id: c.id, publicKey: c.publicKey! } };
    const box = await encryptPayload(await this.conversationKey(myKey, c.id, c.publicKey!), env, payload);
    const ev = { t: "send" as const, id: env.id, to: c.id, fromKey: myKey, toKey: c.publicKey!, ...box, ping: isPing };
    this.upsert(peer, { id: env.id, mine: true, kind: payload.kind, text: payload.kind === "ping" ? "" : payload.text, createdAt: Date.now(), status: "pending" });
    this.outbox.set(env.id, ev);
    this.rt.send(ev); // kalau offline, terkirim otomatis saat tersambung lagi
    return true;
  }

  retry(peer: string, id: string) {
    const msg = this.state.threads[peer]?.messages.find((m) => m.id === id);
    if (!msg || msg.status !== "failed") return;
    this.setThread(peer, (t) => ({ ...t, messages: t.messages.filter((m) => m.id !== id) }));
    if (msg.kind === "text" || msg.kind === "identity") void this.send(peer, { kind: msg.kind, text: msg.text });
  }

  // ------------------------------------------------------ event server ---

  private async onEvent(ev: ServerEvent) {
    switch (ev.t) {
      case "message": {
        const m = ev.message;
        const mine = m.from === this.state.me.id;
        const peer = mine ? m.to : m.from;
        if (!mine) this.rt.send({ t: "delivered", ids: [m.id] });
        const msg = await this.decrypt(m);
        if (this.state.threads[peer]?.loaded || this.state.activePeer === peer) this.upsert(peer, msg);
        if (!mine) {
          const c = this.contact(peer);
          if (this.state.activePeer === peer && document.visibilityState === "visible") this.markRead(peer);
          else if (c) this.set({ contacts: this.state.contacts.map((x) => (x.id === peer ? { ...x, unread: x.unread + 1, lastMessageAt: m.createdAt } : x)) });
          if (msg.kind === "ping") this.showPing(peer);
        }
        this.sortContacts(peer, m.createdAt);
        break;
      }
      case "ack":
        this.outbox.delete(ev.id);
        this.patchStatus([ev.id], ev.status);
        break;
      case "rejected": {
        this.outbox.delete(ev.id);
        this.patchStatus([ev.id], "failed", ev.message);
        if (ev.code === "key_changed") await this.refreshContacts();
        if (ev.code === "stale_device_key") this.set({ device: "other_device" });
        if (ev.code !== "key_changed") this.toast(ev.message, "warn");
        break;
      }
      case "status":
        this.patchStatus(ev.ids, ev.status);
        break;
      case "contacts_changed":
        await this.refreshContacts();
        break;
      case "key_changed":
        if (ev.userId === this.state.me.id) {
          const { me } = await api<{ me: Me }>("GET", "/api/me");
          this.set({ me, device: me.publicKey === this.identity?.publicKey ? "ok" : "other_device" });
        } else {
          await this.refreshContacts();
        }
        break;
      case "deals_changed":
        if (this.state.deals[ev.peer] || this.state.activePeer === ev.peer) await this.loadDeals(ev.peer);
        if (this.state.wallet) void this.loadWallet();
        break;
      case "products_changed":
        if (ev.owner === this.state.me.id) await this.loadMyStore();
        else if (this.state.catalogs[ev.owner]) await this.loadCatalog(ev.owner).catch(() => {});
        break;
      case "hello":
        break;
    }
  }

  private sortContacts(peer: string, at: number) {
    const contacts = this.state.contacts.map((c) => (c.id === peer ? { ...c, lastMessageAt: at } : c));
    contacts.sort((a, b) => (b.lastMessageAt ?? b.since) - (a.lastMessageAt ?? a.since));
    this.set({ contacts });
  }

  private showPing(peer: string) {
    // Lapisan kedua anti-teror: walau server dilewati, layar hanya bergetar 30 detik sekali per kontak.
    const last = this.lastPingShown.get(peer) ?? 0;
    if (Date.now() - last < PING_COOLDOWN_MS) return;
    this.lastPingShown.set(peer, Date.now());
    this.set({ ping: { peer, at: Date.now() } });
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) navigator.vibrate?.([120, 60, 120]);
    const c = this.contact(peer);
    if (c) this.toast(`${c.alias} mengirim PING!!!`, "warn");
  }
}
