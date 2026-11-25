import { Worker, Job, DelayedError } from "bullmq";
import nodemailer, { SentMessageInfo, Transporter } from "nodemailer";
import { config } from "./config";
import { prisma } from "./db";
import { EmailTask, EMAIL_QUEUE_NAME } from "./queue";
import { indexEmail } from "./search";
import { notifyRateLimit } from "./slack";
import { redis } from "./redis";

const throttleScript = `
local nowParts = redis.call('TIME')
local now = tonumber(nowParts[1]) * 1000 + math.floor(tonumber(nowParts[2]) / 1000)
local hour = math.floor(now / 3600000)
local rateKey = KEYS[1] .. ':' .. hour
local capKey = KEYS[3] .. ':' .. hour
local globalRateKey = KEYS[4] .. ':' .. hour
local count = tonumber(redis.call('GET', rateKey) or '0')
local globalCount = tonumber(redis.call('GET', globalRateKey) or '0')
local requestedLimit = tonumber(ARGV[1])
local currentLimit = tonumber(redis.call('GET', capKey) or '0')
if currentLimit == 0 then
  redis.call('SET', capKey, requestedLimit, 'EX', 7200)
elseif requestedLimit < currentLimit then
  redis.call('SET', capKey, requestedLimit, 'EX', 7200)
  currentLimit = requestedLimit
end
local limit = currentLimit
local globalLimit = tonumber(ARGV[3])
if count >= limit or globalCount >= globalLimit then
  return {1, (hour + 1) * 3600000 - now}
end
local lastSend = tonumber(redis.call('GET', KEYS[2]) or '0')
local wait = lastSend + tonumber(ARGV[2]) - now
if wait > 0 then
  return {2, wait}
end
redis.call('INCR', rateKey)
redis.call('EXPIRE', rateKey, 7200)
redis.call('INCR', globalRateKey)
redis.call('EXPIRE', globalRateKey, 7200)
redis.call('SET', KEYS[2], now, 'PX', math.max(tonumber(ARGV[2]) * 2, 60000))
return {0, 0}
`;

const transporters = new Map<string, Transporter>();

function getTransporter(senderEmail: string): Transporter {
  const sender = config.senders.get(senderEmail.toLowerCase());
  if (!sender) throw new Error(`No SMTP configuration exists for sender ${senderEmail}`);
  const existing = transporters.get(sender.email.toLowerCase());
  if (existing) return existing;
  const transporter = nodemailer.createTransport({
    host: sender.host,
    port: sender.port,
    secure: sender.port === 465,
    requireTLS: sender.port === 587,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    auth: { user: sender.user, pass: sender.pass },
  });
  transporters.set(sender.email.toLowerCase(), transporter);
  return transporter;
}

async function reserveSendSlot(task: EmailTask): Promise<{ reason: number; waitMs: number }> {
  const senderKey = `${task.userId}:${task.senderEmail.toLowerCase()}`;
  const globalSenderKey = task.senderEmail.toLowerCase();
  const result = (await redis.eval(
    throttleScript,
    4,
    `email-rate:${senderKey}`,
    `email-last-send:${globalSenderKey}`,
    `email-rate-limit:${senderKey}`,
    `email-global-rate:${globalSenderKey}`,
    Math.min(task.hourlyLimit, config.defaultMaxEmailsPerHour),
    Math.max(task.delayMs, config.minDelayBetweenEmailsMs),
    config.defaultMaxEmailsPerHour,
  )) as [number, number];
  return { reason: Number(result[0]), waitMs: Number(result[1]) };
}

async function processEmail(job: Job<EmailTask>, token?: string): Promise<void> {
  const task = job.data;
  const email = await prisma.emailJob.findUnique({ where: { id: task.emailJobId } });
  if (!email || email.status === "sent" || email.status === "sending") return;
  if (email.status !== "scheduled") return;

  const claimed = await prisma.emailJob.updateMany({
    where: { id: task.emailJobId, status: "scheduled" },
    data: { status: "sending" },
  });
  if (claimed.count !== 1) return;

  let slot: { reason: number; waitMs: number };
  try {
    slot = await reserveSendSlot(task);
  } catch (error) {
    await prisma.emailJob.updateMany({
      where: { id: task.emailJobId, status: "sending" },
      data: { status: "scheduled" },
    });
    throw error;
  }
  if (slot.reason !== 0) {
    const restored = await prisma.emailJob.updateMany({
      where: { id: task.emailJobId, status: "sending" },
      data: { status: "scheduled" },
    });
    if (restored.count !== 1) {
      throw new Error(`Could not restore email ${task.emailJobId} after a throttle delay`);
    }
    if (slot.reason === 1) {
      try {
        await notifyRateLimit(task.userId, task.senderEmail);
      } catch (error) {
        console.error("Unable to deliver Slack rate-limit notification:", error);
      }
    }
    if (!token) throw new Error("BullMQ worker did not provide a lock token for delayed job");
    await job.moveToDelayed(Date.now() + Math.max(slot.waitMs, 1000), token);
    throw new DelayedError();
  }

  const sender = config.senders.get(task.senderEmail.toLowerCase());
  let info: SentMessageInfo;
  try {
    if (!sender) throw new Error(`No SMTP configuration exists for sender ${task.senderEmail}`);
    info = await getTransporter(task.senderEmail).sendMail({
      from: { name: sender.name, address: sender.email },
      to: task.recipient,
      subject: task.subject,
      text: task.body,
    });
  } catch (error) {
    const restored = await prisma.emailJob.updateMany({
      where: { id: task.emailJobId, status: "sending" },
      data: { status: "scheduled" },
    });
    if (restored.count !== 1) {
      throw new Error(`Could not restore email ${task.emailJobId} after a delivery attempt failed`);
    }
    throw error;
  }

  const sentEmail = await prisma.emailJob.update({
    where: { id: task.emailJobId },
    data: { status: "sent", sentAt: new Date(), error: null },
  });
  try {
    await indexEmail(sentEmail);
  } catch (error) {
    console.error(`Email ${task.emailJobId} was sent but could not be indexed:`, error);
  }
  const previewUrl = nodemailer.getTestMessageUrl(info);
  console.log(`Sent ${task.emailJobId} to ${task.recipient}${previewUrl ? ` — ${previewUrl}` : ""}`);
}

export const emailWorker = new Worker<EmailTask>(
  EMAIL_QUEUE_NAME,
  processEmail,
  {
    connection: redis.duplicate(),
    concurrency: config.workerConcurrency,
    autorun: false,
  },
);

emailWorker.on("completed", (job) => {
  console.log(`Email job ${job.id} completed`);
});
emailWorker.on("failed", (job, error) => {
  console.error(`Email job ${job?.id ?? "unknown"} failed:`, error);
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;

  void prisma.emailJob.updateMany({
    where: {
      id: job.data.emailJobId,
      status: { in: ["scheduled", "sending"] },
    },
    data: {
      status: "failed",
      error: `Worker exhausted retries; delivery outcome may be uncertain: ${error.message}`,
    },
  }).then(async (result) => {
    if (result.count !== 1) return;
    const failedEmail = await prisma.emailJob.findUnique({
      where: { id: job.data.emailJobId },
    });
    if (failedEmail) await indexEmail(failedEmail);
  }).catch((failure: unknown) => {
    console.error(`Could not persist final failure for email ${job.data.emailJobId}:`, failure);
  });
});
emailWorker.on("error", (error) => {
  console.error("Email worker error:", error);
});

export async function closeWorker(): Promise<void> {
  await emailWorker.close();
}

export function startWorker(): void {
  void emailWorker.run().catch((error: unknown) => {
    console.error("Email worker stopped unexpectedly:", error);
  });
}
