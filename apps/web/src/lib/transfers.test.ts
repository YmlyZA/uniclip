import { describe, it, expect } from "vitest";
import {
  addOutgoing, applyOffer, applyProgress, applyReceived, applyError,
  applyCancel, removeTransfer, markTransferring,
} from "./transfers";

describe("transfers reducers", () => {
  it("addOutgoing appends a send/transferring item", () => {
    const l = addOutgoing([], { fileId: "f1", name: "a", mime: "text/plain", size: 10, total: 1 }, 100);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ fileId: "f1", dir: "send", state: "transferring", sent: 0, total: 1, mine: true, ts: 100 });
  });

  it("applyOffer: inline → transferring, non-inline → offering; dedups by fileId", () => {
    let l = applyOffer([], { fileId: "f2", name: "p.png", mime: "image/png", size: 4, chunkCount: 1, inline: true }, 1);
    expect(l[0]).toMatchObject({ dir: "recv", state: "transferring", mine: false });
    l = applyOffer(l, { fileId: "f3", name: "b", mime: "x", size: 1, chunkCount: 2, inline: false }, 2);
    expect(l.find((t) => t.fileId === "f3")?.state).toBe("offering");
    expect(applyOffer(l, { fileId: "f3", name: "b", mime: "x", size: 1, chunkCount: 2, inline: false }, 3)).toHaveLength(2);
  });

  it("applyProgress updates sent/total and marks a SEND done at sent===total", () => {
    let l = addOutgoing([], { fileId: "f1", name: "a", mime: "x", size: 10, total: 3 }, 0);
    l = applyProgress(l, { fileId: "f1", dir: "send", sent: 2, total: 3 });
    expect(l[0]).toMatchObject({ sent: 2, state: "transferring" });
    l = applyProgress(l, { fileId: "f1", dir: "send", sent: 3, total: 3 });
    expect(l[0]?.state).toBe("done");
  });

  it("a recv progress reaching total does NOT mark done (waits for file-received)", () => {
    let l = applyOffer([], { fileId: "r1", name: "a", mime: "x", size: 1, chunkCount: 2, inline: true }, 0);
    l = applyProgress(l, { fileId: "r1", dir: "recv", sent: 2, total: 2 });
    expect(l[0]?.state).toBe("transferring");
  });

  it("applyReceived attaches the blob + marks done", () => {
    let l = applyOffer([], { fileId: "r1", name: "a", mime: "text/plain", size: 1, chunkCount: 1, inline: true }, 0);
    const blob = new Blob(["hi"]);
    l = applyReceived(l, { fileId: "r1", blob });
    expect(l[0]?.state).toBe("done");
    expect(l[0]?.blob).toBe(blob);
  });

  it("applyError marks error and ignores an empty fileId (pre-flight)", () => {
    let l = addOutgoing([], { fileId: "f1", name: "a", mime: "x", size: 1, total: 1 }, 0);
    expect(applyError(l, { fileId: "", message: "x" })).toEqual(l);
    l = applyError(l, { fileId: "f1", message: "boom" });
    expect(l[0]).toMatchObject({ state: "error", errorMsg: "boom" });
  });

  it("markTransferring flips offering→transferring; applyCancel→cancelled; removeTransfer drops", () => {
    let l = applyOffer([], { fileId: "r1", name: "a", mime: "x", size: 1, chunkCount: 2, inline: false }, 0);
    expect(l[0]?.state).toBe("offering");
    l = markTransferring(l, "r1");
    expect(l[0]?.state).toBe("transferring");
    l = applyCancel(l, { fileId: "r1" });
    expect(l[0]?.state).toBe("cancelled");
    expect(removeTransfer(l, "r1")).toHaveLength(0);
  });
});
