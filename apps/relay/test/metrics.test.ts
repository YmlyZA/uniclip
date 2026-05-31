import { describe, expect, it } from "vitest";
import { Metrics } from "../src/metrics";

describe("Metrics", () => {
  it("renders gauges and counters in Prometheus text format", () => {
    const m = new Metrics();
    m.setGauge("uniclip_rooms_total", 3);
    m.setGauge("uniclip_sockets_total", 7);
    m.inc("uniclip_frames_in_total");
    m.inc("uniclip_frames_in_total");
    m.inc("uniclip_errors_total", 1, { code: "RATE_LIMIT" });
    const out = m.render();
    expect(out).toContain("uniclip_rooms_total 3");
    expect(out).toContain("uniclip_sockets_total 7");
    expect(out).toContain("uniclip_frames_in_total 2");
    expect(out).toContain('uniclip_errors_total{code="RATE_LIMIT"} 1');
  });
});
