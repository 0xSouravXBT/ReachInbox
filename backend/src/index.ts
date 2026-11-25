import { config } from "./config";
import { prisma } from "./db";
import { redis } from "./redis";
import { emailQueue } from "./queue";
import { createApp } from "./app";
import { ensureSearchIndex, indexEmails } from "./search";
import { closeWorker, startWorker } from "./worker";
import { reconcileScheduledJobs } from "./scheduling";

async function start(): Promise<void> {
  await prisma.$connect();
  await redis.ping();
  await ensureSearchIndex();
  let cursor: string | undefined;
  while (true) {
    const batch = await prisma.emailJob.findMany({
      select: {
        id: true,
        userId: true,
        recipient: true,
        senderEmail: true,
        subject: true,
        status: true,
        scheduledAt: true,
        sentAt: true,
      },
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) break;
    await indexEmails(batch);
    cursor = batch[batch.length - 1].id;
  }
  const recoveredJobs = await reconcileScheduledJobs();
  console.log(`Recovered ${recoveredJobs} scheduled email jobs`);
  startWorker();

  const server = createApp().listen(config.port, () => {
    console.log(`API and BullMQ worker available on http://localhost:${config.port}`);
    console.log(`Queue dashboard: http://localhost:${config.port}/admin/queues`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received; closing services`);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await closeWorker();
    await emailQueue.close();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch(async (error: unknown) => {
  console.error("Backend startup failed:", error);
  await Promise.allSettled([closeWorker(), emailQueue.close()]);
  redis.disconnect();
  await prisma.$disconnect();
  process.exitCode = 1;
});
