export interface User {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
  slackConnection: { teamName: string; connectedAt: string } | null;
}

export interface Sender {
  email: string;
  name: string;
}

export interface SenderConfig {
  senders: Sender[];
  defaultHourlyLimit: number;
  minDelayBetweenEmailsMs: number;
}

export interface EmailRecord {
  id: string;
  recipient: string;
  senderEmail: string;
  subject: string;
  scheduledAt: string;
  sentAt: string | null;
  status: "scheduled" | "sending" | "sent" | "failed";
  error: string | null;
}

export interface EmailListResponse {
  emails: EmailRecord[];
  total: number;
  page: number;
  pageSize: number;
}
