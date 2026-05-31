export class Metrics {
  private gauges = new Map<string, number>();
  private counters = new Map<string, number>(); // key = name|labelsString

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  inc(name: string, by = 1, labels: Record<string, string> = {}): void {
    const key = name + "|" + this.serializeLabels(labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  private serializeLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return "";
    return entries.map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(",");
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, value] of this.gauges) lines.push(`${name} ${value}`);
    for (const [key, value] of this.counters) {
      // Split on the FIRST "|" only — label values may themselves contain "|".
      const pipe = key.indexOf("|");
      const name = key.slice(0, pipe);
      const labelStr = key.slice(pipe + 1);
      lines.push(labelStr ? `${name}{${labelStr}} ${value}` : `${name} ${value}`);
    }
    return lines.join("\n") + "\n";
  }
}
