import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { config } from "./config";
import { decryptToken } from "./crypto";
import { redis } from "./redis";

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  channel?: { id: string };
  user?: { id: string };
  team?: { name: string };
  authed_user?: { id: string };
  access_token?: string;
  token_type?: string;
}

const releaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export async function notifyRateLimit(
  userId: string,
  senderEmail: string,
): Promise<void> {
  const connection = await prisma.slackConnection.findUnique({ where: { userId } });
  if (!connection) return;

  const noticeKey = `slack-rate-notice:${userId}:${senderEmail.toLowerCase()}:${Math.floor(Date.now() / 3600000)}`;
  const lockKey = `${noticeKey}:lock`;
  const lockToken = randomUUID();
  const lock = await redis.set(lockKey, lockToken, "EX", 120, "NX");
  if (lock !== "OK") return;

  try {
    if (await redis.exists(noticeKey)) return;
    const accessToken = decryptToken(connection.accessToken);
    const opened = await slackRequest(
      "https://slack.com/api/conversations.open",
      accessToken,
      { users: connection.slackUserId },
    );
    if (!opened.ok || !opened.channel?.id) {
      throw new Error(`Slack could not open a direct message: ${opened.error ?? "unknown error"}`);
    }
    const sent = await slackRequest("https://slack.com/api/chat.postMessage", accessToken, {
      channel: opened.channel.id,
      text: `Hourly email limit reached for ${senderEmail}. Remaining emails are queued for the next hour.`,
    });
    if (!sent.ok) throw new Error(`Slack notification failed: ${sent.error ?? "unknown error"}`);
    await redis.set(noticeKey, "1", "EX", 7200);
  } finally {
    await redis.eval(releaseLockScript, 1, lockKey, lockToken);
  }
}

export async function exchangeSlackCode(
  code: string,
): Promise<{ token: string; slackUserId: string; teamName: string }> {
  if (!config.slackClientId || !config.slackClientSecret) {
    throw new Error("Slack OAuth is not configured");
  }
  const body = new URLSearchParams({
    client_id: config.slackClientId,
    client_secret: config.slackClientSecret,
    code,
    redirect_uri: config.slackCallbackUrl,
  });
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Slack OAuth returned HTTP ${response.status}`);
  const result = (await response.json()) as SlackApiResponse;
  if (!result.ok || !result.access_token || !result.authed_user?.id) {
    throw new Error(`Slack OAuth failed: ${result.error ?? "incomplete response"}`);
  }
  return {
    token: result.access_token,
    slackUserId: result.authed_user.id,
    teamName: result.team?.name ?? "Slack workspace",
  };
}

async function slackRequest(
  url: string,
  token: string,
  payload: Record<string, string>,
): Promise<SlackApiResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Slack API returned HTTP ${response.status}`);
  return (await response.json()) as SlackApiResponse;
}
