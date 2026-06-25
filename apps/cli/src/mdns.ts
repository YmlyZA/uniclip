import { Bonjour, type Service } from "bonjour-service";

const SERVICE_TYPE = "uniclip";

export interface Discovery {
  advertise(opts: { routingId: string; port: number; name: string }): { stop(): void };
  discover(routingId: string, timeoutMs: number): Promise<{ host: string; port: number }>;
}

// Choose a connectable address for a discovered service: prefer IPv4 from the
// advertised addresses, then the responder's source address, then the .local
// hostname (last resort — Node's ws may not resolve mDNS hostnames).
export function pickAddress(service: Pick<Service, "addresses" | "host" | "referer">): string {
  const v4 = service.addresses?.find((a) => a.includes(".") && !a.includes(":"));
  return v4 ?? service.referer?.address ?? service.host;
}

export function bonjourDiscovery(): Discovery {
  return {
    advertise({ routingId, port, name }) {
      const bonjour = new Bonjour();
      bonjour.publish({ name, type: SERVICE_TYPE, protocol: "tcp", port, txt: { rid: routingId } });
      return { stop: () => bonjour.destroy() };
    },
    discover(routingId, timeoutMs) {
      const bonjour = new Bonjour();
      return new Promise<{ host: string; port: number }>((resolve, reject) => {
        const timer = setTimeout(() => {
          bonjour.destroy();
          reject(new Error("room not found on this network"));
        }, timeoutMs);
        bonjour.find({ type: SERVICE_TYPE, protocol: "tcp" }, (service: Service) => {
          if (service.txt?.rid !== routingId) return;
          clearTimeout(timer);
          const host = pickAddress(service);
          const port = service.port;
          bonjour.destroy();
          resolve({ host, port });
        });
      });
    },
  };
}
