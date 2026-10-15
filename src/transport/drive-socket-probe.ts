// Read-only transport probe: a fixed, unauthenticated Apple HEAD request. No
// session, signed allocation, user input, file bytes or mutation is transmitted.
export async function probeDriveContentSocket() {
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { timedOut = true; void socket?.close().catch(() => {}); reject(new Error("Probe timeout")); }, 8000);
    });
    return await Promise.race([deadline, (async () => {
      const { connect } = await import("cloudflare:sockets");
      socket = connect({ hostname: "cws.icloud-content.com", port: 443 }, { secureTransport: "on", allowHalfOpen: false });
      void socket.closed.catch(() => {});
      await socket.opened;
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode("HEAD /0/singleFileUpload?tk=invalid HTTP/1.1\r\nHost: cws.icloud-content.com\r\nConnection: close\r\n\r\n"));
      writer.releaseLock();
      const reader = socket.readable.getReader();
      try {
        let header = "";
        while (!header.includes("\r\n")) {
          const next = await reader.read();
          if (next.done || header.length + next.value.length > 8192) throw new Error("Invalid probe response");
          header += new TextDecoder().decode(next.value);
        }
        const status = /^HTTP\/1\.[01] ([1-5]\d\d) /.exec(header);
        if (!status) throw new Error("Invalid probe response");
        return { tcp: "available" as const, httpStatus: Number(status[1]), failure: null };
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    })()]);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    return { tcp: "unavailable" as const, httpStatus: null, failure: timedOut ? "timeout" : /outbound|not permitted|not allowed|disabled|not supported|not implemented/.test(message) ? "disabled" : "connection" };
  } finally { clearTimeout(timer); await socket?.close().catch(() => {}); }
}
