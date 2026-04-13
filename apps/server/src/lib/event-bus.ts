import type { ServerResponse } from "node:http";

import { sseEventSchema, type SseEvent } from "@vnc-cua/contracts";
import type { FastifyReply } from "fastify";

export class EventBus {
  private readonly clients = new Set<ServerResponse>();

  subscribe(reply: FastifyReply): void {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    this.clients.add(reply.raw);

    const cleanup = () => {
      this.clients.delete(reply.raw);
    };

    reply.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);
  }

  publish(event: SseEvent): void {
    const safeEvent = sseEventSchema.parse(event);
    const payload = `event: ${safeEvent.type}\ndata: ${JSON.stringify(safeEvent)}\n\n`;

    for (const client of this.clients) {
      client.write(payload);
    }
  }

  close(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }
}
