# Cross-device validation — results (copy to cross-device-validation-results-YYYY-MM-DD.md)

Runbook: docs/cross-device-validation.md. Fill one block per row attempted.
Attach the per-end CLI logs (host-<row>.log / join-<row>.log) or pasted Web Copy text.

Environment: <macOS/Linux/Windows versions; Wi-Fi / hotspot / wired / VPN>

---

### Row A — LAN P2P, internet present
- Result: PASS / FAIL
- Path reached: Direct / Relayed
- OS + network:
- diag excerpt / attached log:
- Notes:

### Row B — NAT traversal, different networks
- Result: PASS / FAIL
- Path reached: Direct (srflx) / Relayed
- OS + network:
- diag excerpt / attached log:
- Notes:

### Row C — Zero-internet --lan ⭐
- Result: PASS / FAIL
- Path reached: Direct / Relayed
- Confirmed offline (no srflx): yes / no
- OS + network:
- diag excerpt / attached log:
- Notes:

### Row D — Large file transfer (web)
- Result: PASS / FAIL
- Size + integrity (hash matched): 
- Notes:

### Row E — Reconnect resilience
- Result: PASS / FAIL
- Queued-then-flushed: yes / no · P2P re-established: yes / no
- Notes:

### Row F — Multi-peer presence
- Result: PASS / FAIL
- Roster correct on join/leave: yes / no
- Notes:

### Row G — Cross-platform
- Result: PASS / FAIL
- OS pair:
- Notes:

### Row H — Wrong-network negative
- Result: PASS / FAIL
- Friendly timeout (no hang/crash): yes / no
- Notes:

---

## Summary
- Rows passed: __ / 8
- FAIL rows → open a systematic-debugging cycle each (small: fix directly; large: new spec).
