import type { ServerResponse } from "node:http";

import { sseEventSchema, type SseEvent } from "@vnc-cua/contracts";
import type { FastifyReply } from "fastify";

export class EventBus {
  private readonly clients = new Map<ServerResponse, (event: SseEvent) => boolean>();

  subscribe(
    reply: FastifyReply,
    filter: (event: SseEvent) => boolean = () => true,
  ): void {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    this.clients.set(reply.raw, filter);

    const cleanup = () => {
      this.clients.delete(reply.raw);
    };

    reply.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);
  }

  publish(event: SseEvent): void {
    const safeEvent = sseEventSchema.parse(event);
    const payload = `event: ${safeEvent.type}\ndata: ${JSON.stringify(safeEvent)}\n\n`;

    for (const [client, filter] of this.clients) {
      if (!filter(safeEvent)) {
        continue;
      }
      client.write(payload);
    }
  }

  close(): void {
    for (const client of this.clients.keys()) {
      client.end();
    }
    this.clients.clear();
  }
}
