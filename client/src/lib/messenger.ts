import {
  decryptPayload,
  deriveConversationKey,
  deriveSelfKey,
  type MomentType,
  E2EEError,
  encryptPayload,
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
  type ModDispute,
  type MyRadar,
  type RadarEntry,
  type ShadowPin,
  type Reaction,
  type StoredMoment,
  type OutgoingRequest,
  type Product,
  type ProStatus,
  type PublicConfig,
  type ServerEvent,
  type StoredMessage,
  type Wallet,
} from "../../../shared/protocol.ts";
import {
  activeItems,
  chunkItems,
  CtlError,
  GHOST_MAX_ITEMS,
  GHOST_ORDER_PER_HOUR,
  GHOST_REQ_PER_HOUR,
  GHOST_TTL_MS,
  PartCollector,
  SlidingLimiter,
  validateCtl,
  validateItem,
  type Ctl,
  type GhostItem,
  type NackReason,
} from "../../../shared/ctl.ts";
import { api, ApiError } from "./api.ts";
import { keystore, type LocalMessage, type PinnedKey, type UnlockedDevice } from "./keystore.ts";
import { BACKUP_MAX_BYTES, decryptBackup, encryptBackup } from "../../../shared/vault.ts";
import { parseReceipt, receiptHash, verifyReceipt, type ReceiptBody, type SignedReceipt } from "../../../shared/receipt.ts";
import { comparePeerEntry, parseTxEntry, signTxEntry, TXLOG_KIND, txEntryHash, verifyTxEntry, type SignedTxEntry, type TxEntryBody, type TxEvidence } from "../../../shared/txlog.ts";
import { addRecipients, cleanDisplayText, openSealed, seal, type Recipient, type SealedKind, type SealedView } from "../../../shared/sealed.ts";
import {
  NOTE_MAX,
  PM_MAX,
  PRODUCT_DESC_MAX,
  PRODUCT_TITLE_MAX,
  STATEMENT_MAX,
  type DealContent,
  type DealKeys,
  type LabelContent,
  type ProductContent,
  type ResolutionContent,
  type ShipmentContent,
  type StatementContent,
} from "../../../shared/protocol.ts";

/** Hasil verifikasi kuitansi notaris untuk satu kesepakatan. */
export type ReceiptCheck =
  | { state: "ok"; seq: number }
  | { state: "invalid" | "mismatch" | "rollback" | "missing"; seq: number | null };
import { Realtime, type ConnState } from "./realtime.ts";

/** X = kedaluwarsa: belum terkirim dalam 30 hari, ciphertext sudah dihapus server. */
export type MsgStatus = "pending" | "S" | "D" | "R" | "failed" | "X";

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

/** Pesan kendali E2EE (Etalase Hantu): tidak pernah masuk linimasa chat maupun disimpan di riwayat. */
export interface CtlMessage {
  kind: "ctl";
  id: string;
  mine: boolean;
  createdAt: number;
  ctl: unknown;
}
const isCtl = (m: ChatMessage | CtlMessage): m is CtlMessage => m.kind === "ctl";
const newId = () => crypto.randomUUID().replace(/-/g, "");

/** Status Buku Jejak Transaksi satu kesepakatan, untuk ditampilkan di kartu. */
export interface TxStatus {
  /** Nomor kuitansi notaris terbaru yang sudah kucatat. */
  seq: number;
  /** pending = lawan belum menandatangani; ok = tiga tanda tangan cocok; mismatch = kuitansi yang kami lihat BERBEDA; badkey = kunci tanda tangan lawan tidak sama dengan yang dipin. */
  peer: "pending" | "ok" | "mismatch" | "badkey";
}

/** Catatan lokal terenkripsi satu kesepakatan (rahasia `txlog:<dealId>` di brankas). */
interface TxRecord {
  peerId: string;
  mine: Record<number, { entry: SignedTxEntry; receiptHash: string; status: ReceiptBody["status"]; price: number; fee: number; sent: boolean }>;
  peer: Record<number, { entry: SignedTxEntry; state: "pending" | "ok" | "mismatch" }>;
  badKey?: boolean;
}

/** Etalase Hantu milikku (terenkripsi di brankas perangkat; hangus 72 jam). */
export interface GhostStoreData {
  items: GhostItem[];
}

/** Etalase lawan: HANYA di memori selama jendela terbuka. */
export interface GhostView {
  state: "loading" | "ready" | "offline";
  reqId: string;
  items: GhostItem[];
  storeExpiresAt: number;
}

export interface GhostOrder {
  peer: string;
  itemId: string;
  state: "sent" | "done" | "nack";
  reason?: NackReason;
}

export interface Thread {
  messages: ChatMessage[];
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
}

export interface MomentView {
  id: string;
  authorId: string;
  authorAlias: string;
  mine: boolean;
  /** locked = untuk kunci perangkat lain; broken = gagal dibuka */
  state: "ok" | "locked" | "broken";
  type: MomentType;
  text: string;
  untrusted: boolean;
  createdAt: number;
  expiresAt: number;
  reactions: Record<Reaction, number>;
  myReaction: Reaction | null;
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
  // Fase 3 — moderator sengketa
  modQueue: { open: ModDispute[]; resolved: ModDispute[] } | null;
  // Fase 3 — penemuan aman
  shadowPins: ShadowPin[] | null;
  myRadar: MyRadar | null | undefined; // undefined = belum dimuat
  radarEntries: RadarEntry[] | null;
  moments: MomentView[] | null;
  // Notaris kuitansi
  config: PublicConfig | null;
  notaryAlert: string | null;
  receipts: Record<string, ReceiptCheck>;
  // Etalase Hantu
  ghostStore: GhostStoreData | null;
  ghostViews: Record<string, GhostView>;
  ghostOrders: Record<string, GhostOrder>;
  // Buku Jejak Transaksi
  txlog: Record<string, TxStatus>;
}

const RANK: Record<MsgStatus, number> = { failed: -1, pending: 0, S: 1, D: 2, R: 3, X: 1 };

/** Isi file cadangan (setelah didekripsi). */
interface BackupData {
  messages: Omit<LocalMessage, "key" | "owner">[];
  pins: Record<string, PinnedKey>;
  shipping: { name: string; address: string; contact: string } | null;
  receipts: Record<string, number>;
}

const MSG_KINDS = new Set(["text", "ping", "identity", "locked", "broken"]);
const MSG_STATUSES = new Set(["pending", "S", "D", "R", "failed"]);

/** Validasi ketat: cadangan berasal dari luar aplikasi, jangan percaya bentuknya. */
function isBackupMessage(m: unknown): m is Omit<LocalMessage, "key" | "owner"> {
  const o = m as Record<string, unknown>;
  return (
    typeof o === "object" && o !== null &&
    typeof o.id === "string" && o.id.length <= 64 &&
    typeof o.peer === "string" && o.peer.length <= 64 &&
    typeof o.mine === "boolean" &&
    typeof o.text === "string" && o.text.length <= 20_000 &&
    typeof o.createdAt === "number" && Number.isFinite(o.createdAt) &&
    MSG_KINDS.has(o.kind as string) && MSG_STATUSES.has(o.status as string)
  );
}

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
  private readonly device: UnlockedDevice;
  private readonly justSetUp: boolean;

  /** `device` = kunci dari brankas yang sudah dibuka; `justSetUp` = baru dibuat/dipulihkan di sini. */
  constructor(me: Me, device: UnlockedDevice, justSetUp: boolean, onSignedOut: (reason: string) => void) {
    this.onSignedOut = onSignedOut;
    this.device = device;
    this.justSetUp = justSetUp;
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
      modQueue: null,
      shadowPins: null,
      myRadar: undefined,
      radarEntries: null,
      moments: null,
      config: null,
      notaryAlert: null,
      receipts: {},
      ghostStore: null,
      ghostViews: {},
      ghostOrders: {},
      txlog: {},
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
    if (this.state.device === "ok") await this.ensureSignKey().catch(() => {});
    this.rt.start();
    await Promise.all([this.refreshContacts(), this.loadMyStore(), this.loadConfig()]);
    document.addEventListener("visibilitychange", this.onVisible);
  }

  stop() {
    this.rt.stop();
    document.removeEventListener("visibilitychange", this.onVisible);
  }

  private onVisible = () => {
    if (document.visibilityState === "visible" && this.state.activePeer) this.markRead(this.state.activePeer);
  };

  /**
   * Kunci identitas berasal dari frasa kunci (brankas sudah dibuka di device.ts). Kunci privat
   * tidak pernah dikirim; server hanya menerima kunci publik.
   */
  private async setupDevice() {
    const me = this.state.me;
    this.identity = this.device;
    if (me.publicKey === this.device.publicKey) {
      this.set({ device: "ok" });
      return;
    }
    // Kunci di server berbeda: bila perangkat ini BARU disiapkan, daftarkan kuncinya; bila tidak,
    // berarti akun sempat diaktifkan di perangkat lain sesudahnya.
    if (me.publicKey && !this.justSetUp) {
      this.set({ device: "other_device" });
      return;
    }
    const { me: updated } = await api<{ me: Me }>("PUT", "/api/me/key", { publicKey: this.device.publicKey });
    this.set({ me: updated, device: "ok" });
    if (me.publicKey) this.toast("Perangkat ini memakai frasa kunci baru — kontakmu akan melihat safety number baru. Pesan dari kunci lama tidak bisa dibuka di sini.", "warn");
  }

  /** Pakai kembali perangkat ini setelah akun sempat aktif di perangkat lain (kunci frasa perangkat ini). */
  async reclaimDevice() {
    const { me } = await api<{ me: Me }>("PUT", "/api/me/key", { publicKey: this.device.publicKey });
    this.keyCache.clear();
    this.set({ me, device: "ok", threads: {} });
    if (this.state.activePeer) await this.loadThread(this.state.activePeer);
    await this.ensureSignKey().catch(() => {});
    this.toast("Perangkat ini aktif lagi. Kontakmu akan melihat safety number baru.", "ok");
  }

  // -------------------------------------------- brankas lokal & cadangan ---

  /** Alamat pengiriman yang diingat — disimpan terenkripsi di brankas perangkat. */
  getSavedShipping() {
    return keystore.getSecret<{ name: string; address: string; contact: string }>(this.state.me.id, "shipping").catch(() => undefined);
  }

  async setSavedShipping(v: { name: string; address: string; contact: string } | null) {
    if (v) await keystore.putSecret(this.state.me.id, "shipping", v);
    else await keystore.deleteSecret(this.state.me.id, "shipping");
  }

  /** Cadangan riwayat + pin + rahasia kecil, dienkripsi dengan kunci turunan frasa kunci. */
  async exportBackup(): Promise<Blob> {
    const owner = this.state.me.id;
    const receipts: Record<string, number> = {};
    for (const id of Object.keys(this.state.receipts)) {
      const seq = await keystore.getSecret<number>(owner, `receipt:${id}`);
      if (typeof seq === "number") receipts[id] = seq;
    }
    const data: BackupData = {
      messages: (await keystore.allMessages(owner)).map(({ key: _k, owner: _o, ...m }) => m),
      pins: await keystore.allPins(owner),
      shipping: (await this.getSavedShipping()) ?? null,
      receipts,
    };
    const file = await encryptBackup(this.device.backup, owner, data);
    return new Blob([JSON.stringify(file)], { type: "application/json" });
  }

  /**
   * Pulihkan cadangan. `key` = kunci cadangan dari frasa kunci lain (opsional). Gabung tanpa menimpa:
   * pesan yang sudah ada & pin yang sudah dipercaya tetap seperti sekarang.
   */
  async importBackup(file: File, key?: CryptoKey): Promise<{ messages: number; createdAt: number }> {
    if (file.size > BACKUP_MAX_BYTES) throw new ApiError(400, "too_large", "File cadangan terlalu besar");
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      throw new ApiError(400, "bad_backup", "Ini bukan file cadangan KAMBE");
    }
    const owner = this.state.me.id;
    let out: { createdAt: number; data: BackupData };
    try {
      out = await decryptBackup<BackupData>(key ?? this.device.backup, owner, raw);
    } catch (e) {
      throw new ApiError(400, (e as E2EEError).code ?? "bad_backup", (e as Error).message);
    }
    const { data } = out;
    const msgs = Array.isArray(data.messages) ? data.messages.filter(isBackupMessage) : [];
    const peers = [...new Set(msgs.map((m) => m.peer))];
    const existing = new Set<string>();
    for (const p of peers) for (const m of await keystore.getThread(owner, p, Infinity)) existing.add(m.id);
    const fresh = msgs.filter((m) => !existing.has(m.id)).map((m) => ({ ...m, key: `${owner}:${m.id}`, owner }));
    await keystore.putMessages(fresh);
    for (const [peer, pin] of Object.entries(data.pins ?? {})) {
      if (typeof pin?.publicKey === "string" && !(await keystore.getPin(owner, peer))) await keystore.putPin(owner, peer, { publicKey: pin.publicKey, verified: !!pin.verified, firstSeen: Number(pin.firstSeen) || Date.now() });
    }
    if (data.shipping && !(await this.getSavedShipping())) await this.setSavedShipping(data.shipping);
    for (const [id, seq] of Object.entries(data.receipts ?? {})) {
      const cur = (await keystore.getSecret<number>(owner, `receipt:${id}`)) ?? -1;
      if (typeof seq === "number" && seq > cur) await keystore.putSecret(owner, `receipt:${id}`, seq);
    }
    // Muat ulang tampilan dari brankas lokal.
    this.set({ threads: {} });
    await this.refreshContacts();
    if (this.state.activePeer) await this.loadThread(this.state.activePeer);
    return { messages: fresh.length, createdAt: out.createdAt };
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
    void this.syncShares();
    void this.drainPending(contacts);
  }

  /**
   * Zero-click: pesan (termasuk pesan kendali etalase) yang menunggu di relay saat kita offline diambil
   * sekali per kontak tanpa harus membuka chat-nya, supaya permintaan etalase tetap terlayani.
   */
  private draining = new Set<string>();
  private async drainPending(contacts: Contact[]) {
    if (this.state.device !== "ok") return;
    for (const c of contacts) {
      if (c.unread <= 0 || this.state.threads[c.id]?.loaded || this.draining.has(c.id)) continue;
      this.draining.add(c.id);
      try {
        await this.loadThread(c.id);
      } finally {
        this.draining.delete(c.id);
      }
    }
  }

  contact(peer: string) {
    return this.state.contacts.find((c) => c.id === peer);
  }

  // ------------------------------------------- isi terenkripsi (sealed) ---
  // Semua isi selain chat/momen (status, catatan, etalase, judul kesepakatan, bukti kirim,
  // pernyataan, alasan putusan, label) disegel di perangkat ini; server hanya melihat ciphertext.

  private openCache = new Map<string, Promise<unknown>>();
  private modKeyCache: { at: number; keys: Recipient[] } | null = null;
  private shareSignature = "";

  private get self(): Recipient {
    return { id: this.state.me.id, publicKey: this.identity!.publicKey };
  }

  private requireDevice() {
    if (this.state.device !== "ok" || !this.identity) throw new ApiError(409, "device", "Perangkat ini belum aktif untuk akunmu");
  }

  private sealAs(kind: SealedKind, content: unknown, recipients: Recipient[]) {
    this.requireDevice();
    return seal(this.identity!.privateKey, this.self, kind, content, recipients);
  }

  /** Buka isi terenkripsi untuk perangkat ini (hasil di-cache). null = belum dibagikan / tidak sah. */
  open<T>(view: SealedView | null | undefined): Promise<T | null> {
    if (!view || !this.identity) return Promise.resolve(null);
    const k = `${view.id}:${view.wrap?.toKey ?? "-"}:${view.wrap?.wrapped ?? "-"}`;
    let p = this.openCache.get(k);
    if (!p) {
      p = openSealed<T>(this.identity.privateKey, this.identity.publicKey, view).catch(() => null);
      this.openCache.set(k, p);
    }
    return p as Promise<T | null>;
  }

  /** Kontak yang boleh menerima isi baru: punya kunci & safety number-nya TIDAK sedang berubah. */
  private contactRecipients(): Recipient[] {
    return this.state.contacts.filter((c) => c.publicKey && !this.state.keyAlerts[c.id]).map((c) => ({ id: c.id, publicKey: c.publicKey! }));
  }

  async modRecipients(): Promise<Recipient[]> {
    if (this.modKeyCache && Date.now() - this.modKeyCache.at < 60_000) return this.modKeyCache.keys;
    const { moderators } = await api<{ moderators: Recipient[] }>("GET", "/api/mod/keys");
    this.modKeyCache = { at: Date.now(), keys: moderators };
    return moderators;
  }

  /** Pembeli, penjual & moderator sebuah kesepakatan. */
  private async dealRecipients(dealId: string): Promise<Recipient[]> {
    const k = await api<DealKeys>("GET", `/api/deals/${dealId}/keys`);
    return [k.buyer, k.seller, ...k.moderators].filter((x): x is Recipient => !!x);
  }

  /** Bagikan kunci isi milikku ke penerima yang belum punya (kontak baru, moderator baru, kunci baru). */
  private async ensureWraps(view: SealedView | null | undefined, wanted: Recipient[]) {
    if (!view?.wrap || !this.identity || view.ownerId !== this.state.me.id || view.ownerKey !== this.identity.publicKey) return;
    const { recipients } = await api<{ recipients: { id: string; key: string }[] }>("GET", `/api/sealed/${view.id}/recipients`);
    const have = new Map(recipients.map((r) => [r.id, r.key]));
    const missing = wanted.filter((r) => r.id !== this.state.me.id && have.get(r.id) !== r.publicKey);
    if (!missing.length) return;
    const wraps = await addRecipients(this.identity.privateKey, this.self, view, missing);
    await api("POST", `/api/sealed/${view.id}/wraps`, { wraps });
  }

  /** Status & etalase: pastikan semua kontak (yang kuncinya dipercaya) bisa membacanya. */
  private async syncShares() {
    if (this.state.device !== "ok") return;
    const want = this.contactRecipients();
    const sig = JSON.stringify([want, this.state.me.pm?.id, this.state.myProducts.map((p) => p.content?.id)]);
    if (sig === this.shareSignature) return;
    this.shareSignature = sig;
    try {
      await this.ensureWraps(this.state.me.pm, want);
      for (const p of this.state.myProducts) await this.ensureWraps(p.content, want);
    } catch {
      this.shareSignature = ""; // coba lagi pada penyegaran berikutnya
    }
  }

  async invite(pin: string, note: string) {
    // Catatan undangan disegel untuk pemilik PIN; kunci publiknya diambil lewat PIN (tanpa ID internal).
    let sealedNote;
    const text = cleanDisplayText(note, NOTE_MAX);
    if (text) {
      const { publicKey } = await api<{ publicKey: string | null }>("POST", "/api/contacts/lookup", { pin });
      if (!publicKey) throw new ApiError(409, "no_key", "Pemilik PIN belum pernah membuka KAMBE, jadi catatan terenkripsi belum bisa dikirim. Kirim tanpa catatan.");
      sealedNote = await this.sealAs("note", { text }, [{ id: "target", publicKey }]);
    }
    const r = await api<{ status: "pending" | "connected" }>("POST", "/api/contacts/invite", { pin, sealedNote });
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
    await this.forgetSignPin(peer);
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

  async updateSettings(patch: { readReceipts?: boolean; pinRotateDays?: number }) {
    const { me } = await api<{ me: Me }>("PATCH", "/api/me/settings", patch);
    this.set({ me });
  }

  /** Status pribadi: disegel untuk semua kontak; kosong = hapus. */
  async updateStatus(text: string) {
    const clean = cleanDisplayText(text, PM_MAX);
    const { me } = clean
      ? await api<{ me: Me }>("PUT", "/api/me/status", { sealed: await this.sealAs("pm", { text: clean }, this.contactRecipients()) })
      : await api<{ me: Me }>("DELETE", "/api/me/status");
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

  private async decrypt(m: StoredMessage): Promise<ChatMessage | CtlMessage> {
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
      if (p.kind === "moment") throw new E2EEError("bad_payload", "Format pesan tidak dikenal"); // mustahil di saluran "msg"; jaga-jaga
      // Pesan kendali dari kunci yang belum diakui = tidak diproses (bisa jadi penyusup).
      if (p.kind === "ctl") return { kind: "ctl", id: m.id, mine, createdAt: m.createdAt, ctl: untrusted ? null : p.ctl };
      return { ...base, kind: p.kind, text: p.kind === "ping" ? "" : p.text, untrusted };
    } catch (e) {
      return { ...base, kind: "broken", text: "", error: e instanceof E2EEError ? e.message : "Pesan tidak bisa dibuka", untrusted };
    }
  }

  // ---------------------------------------------- mesin lokal (riwayat) ---

  private toLocal(peer: string, m: ChatMessage): LocalMessage {
    return { key: `${this.state.me.id}:${m.id}`, owner: this.state.me.id, peer, ...m };
  }

  /** Simpan pesan (dari state terbaru) ke IndexedDB. Riwayat hanya ada di perangkat — server cuma relay. */
  private persist(peer: string, ids: string[]) {
    const set = new Set(ids);
    const msgs = (this.state.threads[peer]?.messages ?? []).filter((m) => set.has(m.id));
    keystore.putMessages(msgs.map((m) => this.toLocal(peer, m))).catch(() => this.toast("Gagal menyimpan riwayat di perangkat ini", "warn"));
  }

  /**
   * "Hapus untuk saya": pesan hilang dari perangkat ini saja. Lawan bicara tetap punya salinannya,
   * dan server tidak menyimpan riwayat (ciphertext sudah dihapus setelah terkirim).
   */
  async forgetMessage(peer: string, id: string): Promise<void> {
    await keystore.deleteMessages(this.state.me.id, [id]);
    this.setThread(peer, (t) => ({ ...t, messages: t.messages.filter((m) => m.id !== id) }));
  }

  private upsert(peer: string, msg: ChatMessage, save = true) {
    this.setThread(peer, (t) => {
      const i = t.messages.findIndex((m) => m.id === msg.id);
      if (i < 0) return { ...t, messages: [...t.messages, msg].sort((a, b) => a.createdAt - b.createdAt) };
      const prev = t.messages[i];
      // Status hanya boleh naik (S→D→R), tidak turun karena event yang datang terlambat.
      const status = RANK[msg.status] >= RANK[prev.status] || prev.status === "failed" || msg.status === "X" ? msg.status : prev.status;
      const messages = [...t.messages];
      messages[i] = { ...prev, ...msg, status };
      return { ...t, messages };
    });
    if (save) this.persist(peer, [msg.id]);
  }

  private patchStatus(ids: string[], status: MsgStatus, error?: string) {
    const set = new Set(ids);
    const threads = { ...this.state.threads };
    const touched: [string, string[]][] = [];
    for (const [peer, t] of Object.entries(threads)) {
      const hit = t.messages.filter((m) => set.has(m.id) && (status === "failed" || status === "X" || RANK[status] > RANK[m.status])).map((m) => m.id);
      if (!hit.length) continue;
      threads[peer] = { ...t, messages: t.messages.map((m) => (hit.includes(m.id) ? { ...m, status, error } : m)) };
      touched.push([peer, hit]);
    }
    if (!touched.length) return;
    this.set({ threads });
    for (const [peer, hit] of touched) this.persist(peer, hit);
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
      void this.syncShares();
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

  /** Nama/deskripsi/sektor disegel untuk kontak; hanya harga yang terbaca server (dasar fee). */
  async saveProduct(p: { id?: string; title: string; description: string; sector: string; price: number }) {
    const content: ProductContent = {
      title: cleanDisplayText(p.title, PRODUCT_TITLE_MAX),
      description: cleanDisplayText(p.description, PRODUCT_DESC_MAX),
      sector: p.sector,
    };
    const sealed = await this.sealAs("product", content, this.contactRecipients());
    await api(p.id ? "PATCH" : "POST", p.id ? `/api/products/${p.id}` : "/api/products", { price: p.price, sealed });
    await this.loadMyStore();
    return true;
  }

  async deleteProduct(id: string) {
    await api("DELETE", `/api/products/${id}`);
    await this.loadMyStore();
  }

  // ------------------------------------------------- notaris & kuitansi ---

  private notaryKey: string | null = null;

  /**
   * Kunci publik notaris: kunci yang DITANAM saat build (VITE_NOTARY_PUBLIC_KEY — untuk APK produksi),
   * atau di-pin saat pertama kali terlihat (TOFU). Bila server tiba-tiba memakai kunci lain → peringatan.
   */
  async loadConfig() {
    try {
      const config = await api<PublicConfig>("GET", "/api/config");
      const embedded = (import.meta.env.VITE_NOTARY_PUBLIC_KEY as string | undefined) || null;
      const owner = this.state.me.id;
      const pinned = embedded ?? (await keystore.getSecret<string>(owner, "notaryKey")) ?? null;
      if (!pinned) await keystore.putSecret(owner, "notaryKey", config.notaryPublicKey);
      this.notaryKey = pinned ?? config.notaryPublicKey;
      const notaryAlert =
        this.notaryKey !== config.notaryPublicKey
          ? "Kunci notaris server berbeda dari yang dipercaya perangkat ini. Kuitansi baru tidak akan dianggap sah — jangan lakukan pembayaran sampai jelas."
          : null;
      this.set({ config, notaryAlert });
    } catch {
      /* tanpa config, kuitansi berstatus "belum terverifikasi" */
    }
  }

  /** Verifikasi kuitansi tiap kesepakatan: tanda tangan, kecocokan isi, dan anti-rollback (seq tidak boleh mundur). */
  private async checkReceipts(deals: Deal[]) {
    const out: Record<string, ReceiptCheck> = {};
    for (const deal of deals) {
      if (!deal.receipt || !this.notaryKey) {
        out[deal.id] = { state: "missing", seq: null };
        continue;
      }
      let body;
      try {
        body = parseReceipt(deal.receipt);
      } catch {
        out[deal.id] = { state: "invalid", seq: null };
        continue;
      }
      if (!(await verifyReceipt(this.notaryKey, deal.receipt))) {
        out[deal.id] = { state: "invalid", seq: body.seq };
        continue;
      }
      const matches =
        body.dealId === deal.id && body.status === deal.status && body.price === deal.price && body.fee === deal.fee &&
        body.buyerId === deal.buyerId && body.sellerId === deal.sellerId && body.payRef === deal.payRef;
      if (!matches) {
        out[deal.id] = { state: "mismatch", seq: body.seq };
        continue;
      }
      const owner = this.state.me.id;
      const seen = (await keystore.getSecret<number>(owner, `receipt:${deal.id}`)) ?? -1;
      if (body.seq < seen) {
        out[deal.id] = { state: "rollback", seq: body.seq };
        continue;
      }
      if (body.seq > seen) await keystore.putSecret(owner, `receipt:${deal.id}`, body.seq);
      out[deal.id] = { state: "ok", seq: body.seq };
      void this.recordTx(deal, body, await receiptHash(deal.receipt)).catch(() => {}); // Buku Jejak: tanda tangan perangkat atas kuitansi yang sah
    }
    this.set({ receipts: { ...this.state.receipts, ...out } });
  }

  async loadCatalog(peer: string) {
    const r = await api<{ pro: boolean; products: Product[] }>("GET", `/api/users/${peer}/products`);
    this.set({ catalogs: { ...this.state.catalogs, [peer]: r } });
  }

  async loadDeals(peer: string) {
    try {
      const { deals } = await api<{ deals: Deal[] }>("GET", `/api/deals?peer=${encodeURIComponent(peer)}`);
      this.set({ deals: { ...this.state.deals, [peer]: deals } });
      void this.checkReceipts(deals);
      void this.shareDisputed(deals);
    } catch {
      /* diabaikan; dicoba lagi saat event berikutnya */
    }
  }

  /**
   * Sengketa berjalan: pastikan moderator SAAT INI bisa membaca isi milikku (judul, bukti kirim,
   * pernyataan) — mis. moderator yang ditunjuk setelah kesepakatan dibuat.
   */
  private async shareDisputed(deals: Deal[]) {
    for (const deal of deals.filter((d) => d.status === "DISPUTED")) {
      try {
        const wanted = await this.dealRecipients(deal.id);
        await this.ensureWraps(deal.content, wanted);
        await this.ensureWraps(deal.shipment, wanted);
        for (const s of deal.statements) await this.ensureWraps(s.content, wanted);
      } catch {
        /* dicoba lagi saat dimuat ulang */
      }
    }
  }

  private upsertDeal(peer: string, deal: Deal) {
    const list = this.state.deals[peer] ?? [];
    const next = list.some((d) => d.id === deal.id) ? list.map((d) => (d.id === deal.id ? deal : d)) : [...list, deal];
    this.set({ deals: { ...this.state.deals, [peer]: next } });
    void this.checkReceipts([deal]);
  }

  /** Lawan transaksi sebagai penerima (harus kontak dengan kunci yang dipercaya). */
  private counterpart(peer: string): Recipient {
    const c = this.contact(peer);
    if (!c?.publicKey) throw new ApiError(409, "no_key", "Lawan transaksi belum punya kunci perangkat");
    if (this.state.keyAlerts[peer]) throw new ApiError(409, "key_alert", "Safety number lawan transaksi berubah — tinjau dulu sebelum bertransaksi");
    return { id: c.id, publicKey: c.publicKey };
  }

  /** Judul kesepakatan disegel untuk penjual & moderator (diambil dari isi produk yang sudah didekripsi). */
  async createDeal(peer: string, productId: string, idempotencyKey: string, title: string) {
    const content: DealContent = { title: cleanDisplayText(title, PRODUCT_TITLE_MAX) };
    const sealed = await this.sealAs("deal", content, [this.counterpart(peer), ...(await this.modRecipients())]);
    const deal = await api<Deal>("POST", "/api/deals", { productId, idempotencyKey, sealed });
    this.upsertDeal(peer, deal);
    return deal;
  }

  async offerDeal(peer: string, title: string, price: number, idempotencyKey: string) {
    const content: DealContent = { title: cleanDisplayText(title, PRODUCT_TITLE_MAX) };
    const sealed = await this.sealAs("deal", content, [this.counterpart(peer), ...(await this.modRecipients())]);
    const deal = await api<Deal>("POST", "/api/deals/offer", { buyerId: peer, price, idempotencyKey, sealed });
    this.upsertDeal(peer, deal);
    return deal;
  }

  /** "ship" butuh bukti kirim, "dispute" butuh cerita — keduanya disegel untuk pembeli, penjual & moderator. */
  async dealAction(peer: string, dealId: string, action: DealAction, content?: ShipmentContent | StatementContent) {
    let body: Record<string, unknown> | undefined;
    if (action === "ship" || action === "dispute") {
      if (!content) throw new ApiError(400, "content_required", action === "ship" ? "Bukti kirim wajib diisi" : "Ceritakan masalahnya");
      body = { sealed: await this.sealAs(action === "ship" ? "shipment" : "statement", content, await this.dealRecipients(dealId)) };
    }
    const deal = await api<Deal>("POST", `/api/deals/${dealId}/${action}`, body);
    this.upsertDeal(peer, deal);
    if (this.state.wallet) void this.loadWallet();
    return deal;
  }

  async addStatement(peer: string, dealId: string, text: string) {
    const content: StatementContent = { text: cleanDisplayText(text, STATEMENT_MAX) };
    const sealed = await this.sealAs("statement", content, await this.dealRecipients(dealId));
    const deal = await api<Deal>("POST", `/api/deals/${dealId}/statements`, { sealed });
    this.upsertDeal(peer, deal);
    return deal;
  }

  // ------------------------------------------------ Path Moments (Fase 3) ---

  private async openMoment(m: StoredMoment): Promise<MomentView> {
    const meId = this.state.me.id;
    const mine = m.authorId === meId;
    const base = { id: m.id, authorId: m.authorId, authorAlias: m.authorAlias, mine, createdAt: m.createdAt, expiresAt: m.expiresAt, reactions: m.reactions, myReaction: m.myReaction };
    const myKey = this.identity?.publicKey;
    if (!this.identity || m.copy.toKey !== myKey) return { ...base, state: "locked", type: "thought", text: "", untrusted: false };
    const pinned = this.state.pins[m.authorId]?.publicKey;
    const untrusted = !mine && !!pinned && pinned !== m.authorKey;
    try {
      const author = { id: m.authorId, publicKey: m.authorKey };
      const me = { id: meId, publicKey: myKey };
      const key = mine ? await deriveSelfKey(this.identity.privateKey, me) : await this.conversationKey(myKey, m.authorId, m.authorKey);
      const p = await decryptPayload(key, { id: m.id, from: author, to: mine ? author : me }, m.copy.nonce, m.copy.ciphertext, "moment");
      if (p.kind !== "moment") throw new Error("bukan momen");
      return { ...base, state: "ok", type: p.type, text: p.text, untrusted };
    } catch {
      return { ...base, state: "broken", type: "thought", text: "", untrusted };
    }
  }

  async loadMoments() {
    const { moments } = await api<{ moments: StoredMoment[] }>("GET", "/api/moments");
    this.set({ moments: await Promise.all(moments.map((m) => this.openMoment(m))) });
  }

  /** Enkripsi momen untuk setiap kontak (yang kuncinya sudah diakui) + salinan diri sendiri. */
  async postMoment(type: MomentType, text: string): Promise<number> {
    if (this.state.device !== "ok" || !this.identity) throw new ApiError(409, "device", "Perangkat ini belum aktif untuk akunmu");
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.refreshContacts();
      const myKey = this.identity.publicKey;
      const me = { id: this.state.me.id, publicKey: myKey };
      const id = crypto.randomUUID();
      const payload = { kind: "moment" as const, type, text };
      // Kontak dengan safety number berubah yang belum ditinjau TIDAK ikut dikirimi (bisa jadi penyusup).
      const recipients = this.state.contacts.filter((c) => c.publicKey && !this.state.keyAlerts[c.id]);
      const copies = [
        { to: me.id, toKey: myKey, ...(await encryptPayload(await deriveSelfKey(this.identity.privateKey, me), { id, from: me, to: me }, payload, "moment")) },
        ...(await Promise.all(
          recipients.map(async (c) => {
            const them = { id: c.id, publicKey: c.publicKey! };
            return { to: c.id, toKey: them.publicKey, ...(await encryptPayload(await this.conversationKey(myKey, c.id, them.publicKey), { id, from: me, to: them }, payload, "moment")) };
          }),
        )),
      ];
      try {
        await api("POST", "/api/moments", { id, fromKey: myKey, copies });
        await this.loadMoments();
        return recipients.length;
      } catch (e) {
        if (attempt === 0 && e instanceof ApiError && e.code === "key_changed") continue; // kunci kontak berubah di tengah jalan → muat ulang & coba sekali lagi
        throw e;
      }
    }
    return 0;
  }

  async reactMoment(id: string, emoji: Reaction | null) {
    await api("POST", `/api/moments/${id}/react`, { emoji });
    await this.loadMoments();
  }

  async deleteMoment(id: string) {
    await api("DELETE", `/api/moments/${id}`);
    this.set({ moments: (this.state.moments ?? []).filter((m) => m.id !== id) });
  }

  // ------------------------------------------- Shadow PIN & radar (Fase 3) ---

  async loadShadowPins() {
    this.set({ shadowPins: (await api<{ pins: ShadowPin[] }>("GET", "/api/shadow-pins")).pins });
  }

  /** Label hanya untukku → disegel untuk diri sendiri saja (server tidak bisa membacanya). */
  async createShadowPin(label: string, once = false) {
    const text = cleanDisplayText(label, 40);
    const sealedLabel = text ? await this.sealAs("label", { text } satisfies LabelContent, []) : undefined;
    const pin = await api<ShadowPin>("POST", "/api/shadow-pins", { once, sealedLabel });
    await this.loadShadowPins();
    return pin;
  }

  async revokeShadowPin(pin: string) {
    await api("DELETE", `/api/shadow-pins/${pin}`);
    await Promise.all([this.loadShadowPins(), this.refreshContacts()]);
  }

  async loadMyRadar() {
    this.set({ myRadar: (await api<{ radar: MyRadar | null }>("GET", "/api/radar/me")).radar });
  }

  async loadRadar(sector: string | null) {
    const q = sector ? `?sector=${encodeURIComponent(sector)}` : "";
    this.set({ radarEntries: (await api<{ entries: RadarEntry[] }>("GET", `/api/radar${q}`)).entries });
  }

  async joinRadar(sector: string, headline: string) {
    this.set({ myRadar: (await api<{ radar: MyRadar }>("PUT", "/api/radar", { sector, headline })).radar });
  }

  async leaveRadar() {
    await api("DELETE", "/api/radar");
    this.set({ myRadar: null, radarEntries: null });
  }

  async loadModQueue() {
    if (!this.state.me.isModerator) return;
    this.set({ modQueue: await api<{ open: ModDispute[]; resolved: ModDispute[] }>("GET", "/api/mod/disputes") });
  }

  /** Keputusan terbaca server (untuk memindahkan dana); ALASAN disegel untuk pembeli, penjual & moderator. */
  async resolveDispute(dealId: string, decision: "refund" | "release", reason: string) {
    const content: ResolutionContent = { reason: cleanDisplayText(reason, 500) };
    const sealed = await this.sealAs("resolution", content, await this.dealRecipients(dealId));
    await api("POST", `/api/mod/disputes/${dealId}/resolve`, { decision, sealed });
    await this.loadModQueue();
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

  /**
   * Local-first: tampilkan riwayat dari perangkat dulu, lalu ambil pesan yang masih menunggu di relay,
   * simpan lokal, BARU konfirmasi "delivered" (saat itulah server menghapus ciphertext-nya).
   */
  async loadThread(peer: string) {
    const me = this.state.me.id;
    this.setThread(peer, (t) => ({ ...t, loading: true }));
    const local = await keystore.getThread(me, peer).catch(() => [] as LocalMessage[]);
    this.setThread(peer, (t) => {
      const byId = new Map<string, ChatMessage>();
      for (const l of local) {
        const { key: _k, owner: _o, peer: _p, ...m } = l;
        byId.set(m.id, m);
      }
      for (const m of t.messages) byId.set(m.id, { ...byId.get(m.id), ...m }); // yang di memori (mis. masih pending) menang
      return { ...t, messages: [...byId.values()].sort((a, b) => a.createdAt - b.createdAt), loaded: true };
    });
    try {
      const { pending, statuses } = await api<{ pending: StoredMessage[]; statuses: { id: string; status: MsgStatus }[] }>("GET", `/api/messages/${peer}`);
      const all = await Promise.all(pending.map((m) => this.decrypt(m)));
      const decrypted = all.filter((m): m is ChatMessage => !isCtl(m));
      const ctls = all.filter(isCtl).filter((c) => !c.mine);
      for (const msg of decrypted) this.upsert(peer, msg, false);
      await keystore.putMessages(decrypted.map((m) => this.toLocal(peer, m)));
      if (decrypted.length) this.rt.send({ t: "delivered", ids: decrypted.map((m) => m.id) });
      // Pesan kendali: tandai dibaca (relay menghapus ciphertext-nya) lalu proses — tanpa jejak di chat.
      if (ctls.length) {
        this.rt.send({ t: "read", peer, ids: ctls.map((c) => c.id) });
        for (const c of ctls) void this.handleCtl(peer, c.ctl);
      }
      for (const s of statuses) this.patchStatus([s.id], s.status);
      this.setThread(peer, (t) => ({ ...t, loading: false }));
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
    if (!c.publicKey) return `${c.alias} belum pernah membuka KAMBE di perangkatnya`;
    if (this.state.keyAlerts[peer]) return "Safety number berubah — tinjau dulu sebelum mengirim";
    return null;
  }

  async send(peer: string, payload: Exclude<Payload, { kind: "moment" | "ctl" }>): Promise<boolean> {
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

  // -------------------------------------- Buku Jejak Transaksi (3 ttd) ---
  // Tiap kuitansi notaris yang LOLOS verifikasi dicatat sebagai entri bertanda tangan perangkat ini
  // (Ed25519 dari frasa kunci), dirantai (prev), disimpan terenkripsi, dan dikirim ke lawan lewat E2EE.
  // Entri lawan diverifikasi (tanda tangan + kunci yang dipin) lalu dicocokkan dengan kuitansi yang
  // kulihat. Cocok = tiga tanda tangan (notaris + aku + lawan). Beda = ditandai & bisa diekspor —
  // TIDAK otomatis jadi sengketa (lihat shared/txlog.ts).

  private txChain: Promise<unknown> = Promise.resolve();
  /** Serialkan semua tulis-baca catatan agar entri yang datang bersamaan tidak saling menimpa. */
  private txSerial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.txChain.then(fn, fn);
    this.txChain = run.catch(() => {});
    return run;
  }

  private async ensureSignKey() {
    const mine = this.device.sign.publicKey;
    if (this.state.me.signKey === mine) return;
    const { me } = await api<{ me: Me }>("PUT", "/api/me/sign-key", { signKey: mine });
    this.set({ me });
  }

  private txKey = (dealId: string) => `txlog:${dealId}`;

  private async getTx(dealId: string): Promise<TxRecord | undefined> {
    return keystore.getSecret<TxRecord>(this.state.me.id, this.txKey(dealId));
  }

  /** Pin kunci tanda tangan lawan (TOFU), terpisah dari pin kunci E2EE. */
  private async signPins(): Promise<Record<string, string>> {
    return (await keystore.getSecret<Record<string, string>>(this.state.me.id, "signpins")) ?? {};
  }

  private async forgetSignPin(peer: string) {
    const pins = await this.signPins();
    if (!(peer in pins)) return;
    delete pins[peer];
    await keystore.putSecret(this.state.me.id, "signpins", pins);
  }

  private evalPeer(rec: TxRecord, seq: number) {
    const m = rec.mine[seq];
    const p = rec.peer[seq];
    if (!m || !p) return;
    p.state = comparePeerEntry({ status: m.status, price: m.price, fee: m.fee, receiptHash: m.receiptHash }, parseTxEntry(p.entry));
  }

  private publishTx(dealId: string, rec: TxRecord) {
    const seqs = Object.keys(rec.mine).map(Number);
    if (!seqs.length) return;
    const seq = Math.max(...seqs);
    const peers = Object.values(rec.peer);
    const peer: TxStatus["peer"] = rec.badKey ? "badkey" : peers.some((p) => p.state === "mismatch") ? "mismatch" : rec.peer[seq]?.state === "ok" ? "ok" : "pending";
    this.set({ txlog: { ...this.state.txlog, [dealId]: { seq, peer } } });
  }

  private recordTx(deal: Deal, body: ReceiptBody, rHash: string) {
    return this.txSerial(async () => {
      const me = this.state.me.id;
      const peer = deal.buyerId === me ? deal.sellerId : deal.buyerId;
      const rec: TxRecord = (await this.getTx(deal.id)) ?? { peerId: peer, mine: {}, peer: {} };
      if (!rec.mine[body.seq]) {
        const earlier = Object.keys(rec.mine).map(Number).filter((n) => n < body.seq);
        const prev = earlier.length ? await txEntryHash(rec.mine[Math.max(...earlier)].entry) : "";
        const eb: TxEntryBody = { v: 1, kind: TXLOG_KIND, dealId: deal.id, seq: body.seq, status: body.status, price: body.price, fee: body.fee, receiptHash: rHash, signer: me, at: Date.now(), prev };
        const entry = await signTxEntry(this.device.sign.privateKey, this.device.sign.publicKey, eb);
        rec.mine[body.seq] = { entry, receiptHash: rHash, status: body.status, price: body.price, fee: body.fee, sent: false };
      }
      this.evalPeer(rec, body.seq);
      // Kirim yang belum terkirim (juga yang tertunda karena lawan sempat offline/kunci berubah).
      for (const [seq, m] of Object.entries(rec.mine)) {
        if (!m.sent && (await this.sendCtl(peer, { t: "txlog.entry", entry: m.entry }))) rec.mine[Number(seq)].sent = true;
      }
      await keystore.putSecret(me, this.txKey(deal.id), rec);
      this.publishTx(deal.id, rec);
    });
  }

  private async receiveTxEntry(peer: string, entry: SignedTxEntry) {
    const eb = parseTxEntry(entry);
    if (eb.signer !== peer) return;
    // Hanya entri untuk kesepakatan yang memang melibatkan kami berdua.
    if (!this.state.deals[peer]?.some((d) => d.id === eb.dealId)) await this.loadDeals(peer);
    const deal = this.state.deals[peer]?.find((d) => d.id === eb.dealId);
    if (!deal) return;
    return this.txSerial(async () => {
      const me = this.state.me.id;
      const c = this.contact(peer);
      if (!c?.signKey) return;
      const pins = await this.signPins();
      if (!pins[peer]) {
        pins[peer] = c.signKey;
        await keystore.putSecret(me, "signpins", pins);
      }
      const rec: TxRecord = (await this.getTx(deal.id)) ?? { peerId: peer, mine: {}, peer: {} };
      if (entry.signKey !== pins[peer] || c.signKey !== pins[peer]) {
        // Kunci tanda tangan lawan tidak sama dengan yang dipercaya: jangan hitung sebagai tanda tangan sah.
        rec.badKey = true;
      } else if (await verifyTxEntry(entry)) {
        if (eb.seq > 64 || (rec.peer[eb.seq] && rec.peer[eb.seq].entry.body !== entry.body)) return; // satu entri per seq; yang berbeda diabaikan
        rec.peer[eb.seq] = rec.peer[eb.seq] ?? { entry, state: "pending" };
        this.evalPeer(rec, eb.seq);
      } else {
        return;
      }
      await keystore.putSecret(me, this.txKey(deal.id), rec);
      this.publishTx(deal.id, rec);
    });
  }

  /** Berkas bukti (kuitansi notaris + entri bertanda tangan kedua pihak) untuk diberikan ke moderator. */
  async exportTxEvidence(dealId: string): Promise<Blob> {
    const rec = await this.getTx(dealId);
    if (!rec) throw new ApiError(404, "no_log", "Belum ada catatan untuk kesepakatan ini");
    const { receipts } = await api<{ receipts: SignedReceipt[] }>("GET", `/api/deals/${dealId}/receipts`);
    const ev: TxEvidence = { v: 1, dealId, receipts, entries: [...Object.values(rec.mine).map((m) => m.entry), ...Object.values(rec.peer).map((p) => p.entry)] };
    return new Blob([JSON.stringify(ev, null, 2)], { type: "application/json" });
  }

  // ------------------------------------------------ Etalase Hantu (E2EE) ---
  // Katalog tinggal di HP penjual (terenkripsi di brankas, hangus 72 jam). Pembeli memintanya lewat
  // pesan kendali E2EE; HP penjual menjawab sendiri. Pembeli hanya menyimpannya di memori.
  // Server tidak pernah melihat isi katalog; hanya ciphertext biasa lewat relay.

  private reqLimiter = new SlidingLimiter(GHOST_REQ_PER_HOUR);
  private orderLimiter = new SlidingLimiter(GHOST_ORDER_PER_HOUR);
  private collectors = new Map<string, PartCollector>();

  /** Kirim pesan kendali E2EE ke kontak (tanpa gelembung chat). */
  private async sendCtl(peer: string, ctl: Ctl): Promise<boolean> {
    if (this.sendBlocker(peer)) return false;
    const c = this.contact(peer)!;
    const myKey = this.identity!.publicKey;
    const env: Envelope = { id: crypto.randomUUID(), from: { id: this.state.me.id, publicKey: myKey }, to: { id: c.id, publicKey: c.publicKey! } };
    const box = await encryptPayload(await this.conversationKey(myKey, c.id, c.publicKey!), env, { kind: "ctl", ctl });
    const ev = { t: "send" as const, id: env.id, to: c.id, fromKey: myKey, toKey: c.publicKey!, ...box, ping: false };
    this.outbox.set(env.id, ev);
    this.rt.send(ev);
    return true;
  }

  private async handleCtl(peer: string, raw: unknown) {
    let ctl: Ctl;
    try {
      ctl = validateCtl(raw);
    } catch (e) {
      if (!(e instanceof CtlError)) throw e;
      return; // pesan kendali tidak sah dari lawan: diabaikan diam-diam
    }
    switch (ctl.t) {
      case "store.req":
        return this.serveStore(peer, ctl.reqId);
      case "store.order":
        return this.serveOrder(peer, ctl.orderId, ctl.itemId);
      case "store.res": {
        const col = this.collectors.get(peer);
        if (!col || !col.add(ctl)) return;
        this.setGhostView(peer, { state: "ready", reqId: col.reqId, items: activeItems(col.items(), Date.now()), storeExpiresAt: col.storeExpiresAt });
        return;
      }
      case "txlog.entry":
        return this.receiveTxEntry(peer, ctl.entry);
      case "store.nack": {
        const o = this.state.ghostOrders[ctl.orderId];
        if (!o || o.peer !== peer) return;
        this.set({ ghostOrders: { ...this.state.ghostOrders, [ctl.orderId]: { ...o, state: "nack", reason: ctl.reason } } });
        const why = { item_gone: "Barangnya sudah tidak tersedia.", seller_not_pro: "Penjual belum bisa menerima pembayaran rekber (butuh PRO).", failed: "Pesanan gagal diproses penjual. Coba lagi nanti." }[ctl.reason];
        this.toast(why, "warn");
      }
    }
  }

  // ---- sisi penjual ----

  async loadGhostStore(): Promise<GhostStoreData> {
    const owner = this.state.me.id;
    const raw = await keystore.getSecret<GhostStoreData>(owner, "ghost-store").catch(() => undefined);
    const now = Date.now();
    const list = Array.isArray(raw?.items) ? raw!.items : [];
    const items: GhostItem[] = [];
    for (const it of list) {
      try {
        const v = validateItem(it);
        if (v.expiresAt > now) items.push(v);
      } catch {
        /* rekaman rusak dibuang */
      }
    }
    const data = { items };
    if (items.length !== list.length) await keystore.putSecret(owner, "ghost-store", data).catch(() => {});
    this.set({ ghostStore: data });
    return data;
  }

  private async saveGhostStore(items: GhostItem[]) {
    const data = { items };
    await keystore.putSecret(this.state.me.id, "ghost-store", data);
    this.set({ ghostStore: data });
  }

  async addGhostItem(p: { title: string; description: string; price: number }) {
    const store = await this.loadGhostStore();
    if (store.items.length >= GHOST_MAX_ITEMS) throw new ApiError(409, "too_many_items", `Maksimal ${GHOST_MAX_ITEMS} barang di Etalase Hantu`);
    let item: GhostItem;
    try {
      item = validateItem({ id: newId(), title: p.title, description: p.description, price: p.price, expiresAt: Date.now() + GHOST_TTL_MS });
    } catch (e) {
      throw new ApiError(400, "bad_item", e instanceof CtlError ? `Barang tidak valid: ${e.message}` : "Barang tidak valid");
    }
    await this.saveGhostStore([...store.items, item]);
    return item;
  }

  async removeGhostItem(itemId: string) {
    const store = await this.loadGhostStore();
    await this.saveGhostStore(store.items.filter((i) => i.id !== itemId));
  }

  /** Perpanjang 72 jam dari sekarang (satu barang, atau semua bila id kosong). */
  async extendGhostItems(itemId?: string) {
    const store = await this.loadGhostStore();
    const expiresAt = Date.now() + GHOST_TTL_MS;
    await this.saveGhostStore(store.items.map((i) => (!itemId || i.id === itemId ? { ...i, expiresAt } : i)));
  }

  private async serveStore(peer: string, reqId: string) {
    if (this.sendBlocker(peer) || !this.reqLimiter.take(peer)) return;
    const store = await this.loadGhostStore();
    const items = activeItems(store.items, Date.now());
    const parts = chunkItems(items);
    const storeExpiresAt = items.reduce((m, i) => Math.max(m, i.expiresAt), 0);
    for (let part = 0; part < parts.length; part++) await this.sendCtl(peer, { t: "store.res", reqId, part, parts: parts.length, items: parts[part], storeExpiresAt });
  }

  /** Pesanan pembeli → tawaran rekber otomatis dengan harga dari katalog SENDIRI (bukan dari pembeli). */
  private async serveOrder(peer: string, orderId: string, itemId: string) {
    if (this.sendBlocker(peer)) return;
    const nack = (reason: NackReason) => void this.sendCtl(peer, { t: "store.nack", orderId, reason });
    if (!this.orderLimiter.take(peer)) return nack("failed");
    const store = await this.loadGhostStore();
    const item = activeItems(store.items, Date.now()).find((i) => i.id === itemId);
    if (!item) return nack("item_gone");
    if (!this.state.pro) await this.loadMyStore();
    if (!this.state.pro?.active) return nack("seller_not_pro");
    try {
      await this.offerDeal(peer, item.title, item.price, orderId); // orderId = idempotencyKey: pesanan ganda tidak menggandakan kesepakatan
      this.toast(`Pesanan "${item.title}" dari ${this.contact(peer)?.alias ?? "pembeli"} — tawaran rekber dikirim.`, "ok");
    } catch {
      nack("failed");
    }
  }

  // ---- sisi pembeli ----

  private setGhostView(peer: string, v: GhostView) {
    this.set({ ghostViews: { ...this.state.ghostViews, [peer]: v } });
  }

  /** Minta etalase kontak. Jawaban datang lewat HP penjual; kalau tidak, dianggap offline setelah 20 detik. */
  async requestGhostStore(peer: string): Promise<boolean> {
    const blocker = this.sendBlocker(peer);
    if (blocker) {
      this.toast(blocker, "warn");
      return false;
    }
    const reqId = newId();
    this.collectors.set(peer, new PartCollector(reqId));
    this.setGhostView(peer, { state: "loading", reqId, items: [], storeExpiresAt: 0 });
    const sent = await this.sendCtl(peer, { t: "store.req", reqId });
    setTimeout(() => {
      const v = this.state.ghostViews[peer];
      if (v && v.reqId === reqId && v.state === "loading") this.setGhostView(peer, { ...v, state: "offline" });
    }, 20_000);
    return sent;
  }

  /** Tutup etalase lawan: katalognya dibuang dari memori (tidak pernah disimpan permanen). */
  clearGhostView(peer: string) {
    this.collectors.delete(peer);
    const { [peer]: _, ...rest } = this.state.ghostViews;
    this.set({ ghostViews: rest });
  }

  async orderGhostItem(peer: string, itemId: string): Promise<boolean> {
    const orderId = newId();
    if (!(await this.sendCtl(peer, { t: "store.order", orderId, itemId }))) return false;
    this.set({ ghostOrders: { ...this.state.ghostOrders, [orderId]: { peer, itemId, state: "sent" } } });
    return true;
  }

  private markOrdersDone(peer: string) {
    const orders = { ...this.state.ghostOrders };
    let changed = false;
    for (const [id, o] of Object.entries(orders)) {
      if (o.peer === peer && o.state === "sent") {
        orders[id] = { ...o, state: "done" };
        changed = true;
      }
    }
    if (changed) {
      this.set({ ghostOrders: orders });
      this.toast("Tawaran rekber dari penjual masuk — cek chat untuk membayar.", "ok");
    }
  }

  // ------------------------------------------------------ event server ---

  private async onEvent(ev: ServerEvent) {
    switch (ev.t) {
      case "message": {
        const m = ev.message;
        const mine = m.from === this.state.me.id;
        const peer = mine ? m.to : m.from;
        const msg = await this.decrypt(m);
        if (isCtl(msg)) {
          // Pesan kendali: proses diam-diam (zero-click), jangan tampil di chat & jangan menambah "belum dibaca".
          if (!mine) {
            this.rt.send({ t: "read", peer, ids: [m.id] });
            void this.handleCtl(peer, msg.ctl);
          }
          break;
        }
        if (this.state.threads[peer]?.loaded || this.state.activePeer === peer) this.upsert(peer, msg, false);
        // Simpan di perangkat DULU; baru konfirmasi agar relay menghapus ciphertext (anti hilang).
        try {
          await keystore.putMessages([this.toLocal(peer, msg)]);
          if (!mine) this.rt.send({ t: "delivered", ids: [m.id] });
        } catch {
          this.toast("Gagal menyimpan pesan di perangkat ini — pesan tetap aman di relay dan dicoba lagi nanti.", "warn");
        }
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
      case "expired":
        this.patchStatus(ev.ids, "X");
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
        this.markOrdersDone(ev.peer);
        if (this.state.deals[ev.peer] || this.state.activePeer === ev.peer) await this.loadDeals(ev.peer);
        if (this.state.wallet) void this.loadWallet();
        break;
      case "me_changed": {
        // Mis. PIN utama dirotasi otomatis oleh server.
        const prevPin = this.state.me.pin;
        const { me } = await api<{ me: Me }>("GET", "/api/me");
        this.set({ me });
        if (me.pin !== prevPin) this.toast(`PIN utama dirotasi otomatis menjadi ${me.pin}. Kontakmu tetap terhubung.`, "info");
        break;
      }
      case "moments_changed":
        if (this.state.moments) await this.loadMoments().catch(() => {});
        break;
      case "mod_queue_changed":
        if (this.state.modQueue) await this.loadModQueue().catch(() => {});
        break;
      case "reshare_needed":
        this.modKeyCache = null;
        await this.loadDeals(ev.peer); // memicu shareDisputed ke kunci moderator yang baru
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
