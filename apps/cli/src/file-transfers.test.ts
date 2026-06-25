import { describe, expect, it } from "vitest";
import { upsertTransfer, removeTransfer, type TransferRow } from "./file-transfers";

describe("file-transfers state", () => {
  it("adds then updates a row by fileId (no duplicates)", () => {
    let rows: TransferRow[] = [];
    rows = upsertTransfer(rows, { fileId: "f1", dir: "send", name: "a.png", sent: 1, total: 10 });
    rows = upsertTransfer(rows, { fileId: "f1", dir: "send", name: "a.png", sent: 5, total: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sent).toBe(5);
  });
  it("removes a row by fileId", () => {
    let rows: TransferRow[] = [{ fileId: "f1", dir: "recv", name: "a", sent: 2, total: 4 }];
    rows = removeTransfer(rows, "f1");
    expect(rows).toHaveLength(0);
  });
});
