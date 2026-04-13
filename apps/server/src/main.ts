import { createApp } from "./server.js";

const { app } = await createApp();

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);

await app.listen({ host, port });
