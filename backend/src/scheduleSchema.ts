import { createHash } from "node:crypto";
import { z } from "zod";

const emailAddress = z.string().trim().email().max(320);

export const scheduleSchema = z.object({
  senderEmail: emailAddress,
  subject: z.string().trim().min(1).max(998),
  body: z.string().min(1).max(100_000),
  recipients: z.array(emailAddress).min(1).max(5000),
  startAt: z.string().datetime({ offset: true }),
  delayMs: z.number().int().min(0).max(86_400_000),
  hourlyLimit: z.number().int().min(1).max(100_000),
});

export type ScheduleInput = z.infer<typeof scheduleSchema>;

export function createScheduleRequestHash(
  input: ScheduleInput,
  canonicalSenderEmail: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      ...input,
      senderEmail: canonicalSenderEmail,
      recipients: input.recipients.map((recipient) => recipient.toLowerCase()),
      startAt: new Date(input.startAt).toISOString(),
    }))
    .digest("hex");
}
