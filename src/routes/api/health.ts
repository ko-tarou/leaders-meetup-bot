import { Hono } from "hono";
import type { Env } from "../../types/env";

export const healthRouter = new Hono<{ Bindings: Env }>();

healthRouter.get("/health", async (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});
