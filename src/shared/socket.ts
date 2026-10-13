/** One route, independent connections: bulk screen frames never share a TCP queue with terminal I/O. */
export function socketUrl(service: string): URL {
  const url = new URL("/socket", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("service", service);
  return url;
}
