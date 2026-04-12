import { Hono } from "hono";
import type { Env } from "../types/env";

const api = new Hono<{ Bindings: Env }>();

api.get("/health", async (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export { api };
