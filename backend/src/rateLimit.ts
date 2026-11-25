import { createHash } from "node:crypto";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { redis } from "./redis";

const incrementWindowScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local windowMs = tonumber(ARGV[1])
local window = math.floor(now / windowMs)
local key = KEYS[1] .. ':' .. window
local count = redis.call('INCR', key)
if count == 1 then
  redis.call('PEXPIRE', key, windowMs * 2)
end
local remaining = (window + 1) * windowMs - now
return {count, remaining}
`;

export function createRateLimiter(
  scope: string,
  maxRequests: number,
  windowMs: number,
  getIdentity: (request: Request) => string = (request) => request.ip || "unknown",
): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const identity = createHash("sha256").update(getIdentity(request)).digest("hex");
    void redis.eval(
      incrementWindowScript,
      1,
      `http-rate:${scope}:${identity}`,
      windowMs,
    ).then((result) => {
      const [count, remainingMs] = result as [number, number];
      if (Number(count) > maxRequests) {
        const retryAfter = Math.max(Math.ceil(Number(remainingMs) / 1000), 1);
        response.setHeader("Retry-After", String(retryAfter));
        response.status(429).json({
          error: "Too many requests; try again later",
          retryAfterSeconds: retryAfter,
        });
        return;
      }
      next();
    }).catch(next);
  };
}
