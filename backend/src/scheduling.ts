import { emailQueue, EmailTask } from "./queue";
import { prisma } from "./db";

type QueueableEmail = {
  id: string;
  userId: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  body: string;
  hourlyLimit: number;
  delayMs: number;
  scheduledAt: Date;
};

function toTask(email: QueueableEmail): EmailTask {
  return {
    emailJobId: email.id,
    userId: email.userId,
    senderEmail: email.senderEmail,
    recipient: email.recipient,
    subject: email.subject,
    body: email.body,
    hourlyLimit: email.hourlyLimit,
    delayMs: email.delayMs,
  };
}

export async function reconcileScheduledJobs(batchSize = 250): Promise<number> {
  let cursor: string | undefined;
  let recovered = 0;

  while (true) {
    const emails = await prisma.emailJob.findMany({
      where: { status: "scheduled" },
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (emails.length === 0) break;

    for (let offset = 0; offset < emails.length; offset += 25) {
      const batch = emails.slice(offset, offset + 25);
      const results = await Promise.all(batch.map(async (email) => {
        const job = await emailQueue.getJob(email.id);
        if (job) {
          const state = await job.getState();
          if (state === "failed") {
            await job.retry("failed", {
              resetAttemptsMade: true,
              resetAttemptsStarted: true,
            });
            return 1;
          }
          if (state === "completed") {
            await job.remove();
          } else {
            return 0;
          }
        }

        await emailQueue.add("send-email", toTask(email), {
          jobId: email.id,
          delay: Math.max(email.scheduledAt.getTime() - Date.now(), 0),
        });
        return 1;
      }));
      recovered += results.reduce<number>((sum, count) => sum + count, 0);
    }

    cursor = emails[emails.length - 1].id;
  }

  return recovered;
}
