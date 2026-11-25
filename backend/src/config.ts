import "dotenv/config";
import { z } from "zod";

const senderSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  user: z.string().min(1),
  pass: z.string().min(1),
  host: z.string().default("smtp.ethereal.email"),
  port: z.coerce.number().int().positive().default(587),
});

const parsedSenders = z.array(senderSchema).parse(
  JSON.parse(process.env.EMAIL_SENDERS ?? "[]"),
);
const emailSenders = new Map(
  parsedSenders.map((sender) => [sender.email.toLowerCase(), sender]),
);

function positiveInteger(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const jwtSecret = process.env.JWT_SECRET ?? "";
if (jwtSecret.length < 32 || jwtSecret.startsWith("replace-")) {
  throw new Error("Set JWT_SECRET to at least 32 random characters");
}

const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY ?? "";
if (!/^[\da-f]{64}$/i.test(encryptionKey) || encryptionKey.startsWith("replace-")) {
  throw new Error("Set TOKEN_ENCRYPTION_KEY to 64 hexadecimal characters");
}

export const config = {
  port: positiveInteger("PORT", 4000),
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  elasticsearchUrl: process.env.ELASTICSEARCH_URL ?? "http://localhost:9200",
  elasticsearchIndex: process.env.ELASTICSEARCH_INDEX ?? "emails",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleCallbackUrl:
    process.env.GOOGLE_CALLBACK_URL ?? "http://localhost:4000/auth/google/callback",
  slackClientId: process.env.SLACK_CLIENT_ID ?? "",
  slackClientSecret: process.env.SLACK_CLIENT_SECRET ?? "",
  slackCallbackUrl:
    process.env.SLACK_CALLBACK_URL ?? "http://localhost:4000/auth/slack/callback",
  jwtSecret,
  tokenEncryptionKey: Buffer.from(encryptionKey, "hex"),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  trustProxyHops: positiveInteger("TRUST_PROXY_HOPS", 1),
  senders: emailSenders,
  defaultMaxEmailsPerHour: positiveInteger("DEFAULT_MAX_EMAILS_PER_HOUR", 100),
  minDelayBetweenEmailsMs: positiveInteger("MIN_DELAY_BETWEEN_EMAILS_MS", 2000),
  workerConcurrency: positiveInteger("WORKER_CONCURRENCY", 5),
  authRequestsPerMinute: positiveInteger("AUTH_REQUESTS_PER_MINUTE", 20),
  scheduleRequestsPerMinute: positiveInteger("SCHEDULE_REQUESTS_PER_MINUTE", 30),
  readRequestsPerMinute: positiveInteger("READ_REQUESTS_PER_MINUTE", 120),
  bullBoardUser: process.env.BULL_BOARD_USER ?? "admin",
  bullBoardPassword: process.env.BULL_BOARD_PASSWORD ?? "",
};
