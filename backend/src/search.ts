import { Client } from "@elastic/elasticsearch";
import { config } from "./config";

export const searchClient = new Client({ node: config.elasticsearchUrl });

export interface SearchableEmail {
  id: string;
  userId: string;
  recipient: string;
  senderEmail: string;
  subject: string;
  status: string;
  scheduledAt: Date;
  sentAt: Date | null;
}

export async function indexEmail(email: SearchableEmail): Promise<void> {
  await indexEmails([email]);
}

export async function indexEmails(emails: SearchableEmail[]): Promise<void> {
  for (let offset = 0; offset < emails.length; offset += 500) {
    const batch = emails.slice(offset, offset + 500);
    const operations = batch.flatMap((email) => [
      { index: { _index: config.elasticsearchIndex, _id: email.id } },
      {
        id: email.id,
        userId: email.userId,
        recipient: email.recipient,
        senderEmail: email.senderEmail,
        subject: email.subject,
        status: email.status,
        scheduledAt: email.scheduledAt.toISOString(),
        sentAt: email.sentAt?.toISOString() ?? null,
      },
    ]);
    const result = await searchClient.bulk({ operations, refresh: "wait_for" });
    if (result.errors) {
      const failedItem = result.items.find((item) =>
        Object.values(item).some((operation) => operation.error),
      );
      const reason = failedItem
        ? Object.values(failedItem).find((operation) => operation.error)?.error?.reason
        : "unknown bulk indexing failure";
      throw new Error(`Elasticsearch could not index emails: ${reason ?? "unknown error"}`);
    }
  }
}

export async function ensureSearchIndex(): Promise<void> {
  const exists = await searchClient.indices.exists({
    index: config.elasticsearchIndex,
  });
  if (exists) return;

  await searchClient.indices.create({
    index: config.elasticsearchIndex,
    mappings: {
      properties: {
        id: { type: "keyword" },
        userId: { type: "keyword" },
        recipient: { type: "text", fields: { keyword: { type: "keyword" } } },
        senderEmail: { type: "text", fields: { keyword: { type: "keyword" } } },
        subject: { type: "text" },
        status: { type: "keyword" },
        scheduledAt: { type: "date" },
        sentAt: { type: "date" },
      },
    },
  });
}
