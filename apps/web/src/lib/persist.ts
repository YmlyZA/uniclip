import { encrypt, decrypt, toBase64, fromBase64 } from "@uniclip/crypto";

export interface Item {
  id: string;
  text: string;
  ts: number;
  /** True when this device sent the item; false/undefined when received. */
  mine?: boolean;
  /** True while a sent item is still queued (offline) and not yet delivered. */
  pending?: boolean;
  /** True when the user pinned this item; pinned items survive cap eviction.
   *  Local-only: persisted at rest but never transmitted. */
  pinned?: boolean;
}

export interface PersistOptions {
  roomId: string;
  key: CryptoKey;
  cap: number;
}

/**
 * Drop oldest UNPINNED items until within cap. Pinned items are protected
 * (the cap is a soft limit on unpinned); if everything is pinned, keep all.
 * Pure and side-effect free so both the persisted store and the live
 * in-memory list (room.svelte) apply the exact same eviction rule.
 */
export function evictOldestUnpinned<T extends { pinned?: boolean }>(items: T[], cap: number): T[] {
  const next = [...items];
  while (next.length > cap) {
    const idx = next.findIndex((i) => !i.pinned);
    if (idx === -1) break; // every remaining item is pinned → keep all
    next.splice(idx, 1);
  }
  return next;
}

/** Storage contract shared by the persisting and ephemeral implementations. */
export interface ItemStore {
  load(): Promise<Item[]>;
  add(item: Item): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): void;
  setPinned(id: string, pinned: boolean): Promise<void>;
}

export class PersistedItems implements ItemStore {
  private items: Item[] = [];
  private readonly storageKey: string;
  private readonly opts: PersistOptions;
  private loaded = false;

  constructor(opts: PersistOptions) {
    this.opts = opts;
    this.storageKey = `uniclip:items:${opts.roomId}`;
  }

  async add(item: Item): Promise<void> {
    if (!this.loaded) await this.load();
    if (this.items.some((i) => i.id === item.id)) return; // dedup by frame identity
    this.items.push(item);
    this.items = evictOldestUnpinned(this.items, this.opts.cap);
    await this.save();
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    if (!this.loaded) await this.load();
    const it = this.items.find((i) => i.id === id);
    if (!it || !!it.pinned === pinned) return;
    it.pinned = pinned;
    await this.save();
  }

  async load(): Promise<Item[]> {
    if (this.loaded) return this.items;
    this.loaded = true;
    const raw = localStorage.getItem(this.storageKey);
    if (!raw) return this.items;
    try {
      const env = JSON.parse(raw) as { iv: string; ciphertext: string };
      const plain = await decrypt({
        key: this.opts.key,
        iv: fromBase64(env.iv),
        ciphertext: fromBase64(env.ciphertext),
        aad: `persist:${this.opts.roomId}`,
      });
      this.items = JSON.parse(plain) as Item[];
    } catch {
      this.items = [];
    }
    return this.items;
  }

  async remove(id: string): Promise<void> {
    if (!this.loaded) await this.load();
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length !== before) await this.save();
  }

  clear(): void {
    this.items = [];
    localStorage.removeItem(this.storageKey);
  }

  private async save(): Promise<void> {
    const env = await encrypt({
      key: this.opts.key,
      plaintext: JSON.stringify(this.items),
      aad: `persist:${this.opts.roomId}`,
    });
    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({ iv: toBase64(env.iv), ciphertext: toBase64(env.ciphertext) }),
      );
    } catch {
      // QuotaExceededError → drop the oldest unpinned item and retry once
      // (fall back to the absolute oldest only if every item is pinned, so we
      // always make progress).
      if (this.items.length > 1) {
        const idx = this.items.findIndex((i) => !i.pinned);
        this.items.splice(idx === -1 ? 0 : idx, 1);
        await this.save();
      }
    }
  }
}

/**
 * No-op store for ephemeral rooms: items live only in the in-memory `items`
 * list (held by room.svelte), so nothing is ever written to localStorage.
 */
export class EphemeralStore implements ItemStore {
  async load(): Promise<Item[]> {
    return [];
  }
  async add(_item: Item): Promise<void> {
    /* intentionally not persisted */
  }
  async remove(_id: string): Promise<void> {
    /* intentionally not persisted */
  }
  clear(): void {
    /* nothing to clear */
  }
  async setPinned(_id: string, _pinned: boolean): Promise<void> {
    /* intentionally not persisted */
  }
}
