import { Database } from "bun:sqlite";
import type { RoomMode } from "./rooms";

export interface RoomRecord {
  id: string;
  mode: RoomMode;
  expiresAt: number;
  backfillEnabled: boolean;
  createdAt: number;
}

interface Row {
  id: string;
  mode: string;
  expires_at: number;
  backfill_enabled: number;
  created_at: number;
}

/**
 * Durable store of room *metadata only* — never frames, keys, sockets, or the
 * backfill ring. Lets room URLs survive a relay restart without retaining
 * anything the relay must not hold.
 */
export class RoomDb {
  private readonly db: Database;

  constructor(dbOrPath: Database | string = ":memory:") {
    this.db = typeof dbOrPath === "string" ? new Database(dbOrPath) : dbOrPath;
    this.db.run(
      `CREATE TABLE IF NOT EXISTS rooms (
         id               TEXT    PRIMARY KEY,
         mode             TEXT    NOT NULL,
         expires_at       INTEGER NOT NULL,
         backfill_enabled INTEGER NOT NULL,
         created_at       INTEGER NOT NULL
       )`,
    );
  }

  insert(rec: RoomRecord): void {
    // REPLACE = DELETE + INSERT under the hood; safe here because we always
    // supply every column (full-row upsert keyed by the PRIMARY KEY id).
    this.db
      .query(
        `INSERT OR REPLACE INTO rooms (id, mode, expires_at, backfill_enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(rec.id, rec.mode, rec.expiresAt, rec.backfillEnabled ? 1 : 0, rec.createdAt);
  }

  get(id: string): RoomRecord | undefined {
    const row = this.db.query(`SELECT * FROM rooms WHERE id = ?`).get(id) as Row | null;
    if (!row) return undefined;
    return {
      id: row.id,
      mode: row.mode as RoomMode,
      expiresAt: row.expires_at,
      backfillEnabled: row.backfill_enabled === 1,
      createdAt: row.created_at,
    };
  }

  delete(id: string): void {
    this.db.query(`DELETE FROM rooms WHERE id = ?`).run(id);
  }

  deleteExpired(now: number): void {
    this.db.query(`DELETE FROM rooms WHERE expires_at <= ?`).run(now);
  }
}
