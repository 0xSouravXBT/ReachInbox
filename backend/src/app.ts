import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Express, NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { Prisma } from "@prisma/client";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { config } from "./config";
import { prisma } from "./db";
import { beginGoogleLogin, finishGoogleLogin, logout, requireAuth, requireUserId } from "./auth";
import { encryptToken } from "./crypto";
import { emailQueue, EmailTask } from "./queue";
import { indexEmails, searchClient } from "./search";
import { exchangeSlackCode } from "./slack";
import { redis } from "./redis";
import { createRateLimiter } from "./rateLimit";
import { createScheduleRequestHash, scheduleSchema } from "./scheduleSchema";

const emailListSelect = {
  id: true,
  recipient: true,
  senderEmail: true,
  subject: true,
  scheduledAt: true,
  sentAt: true,
  status: true,
  error: true,
} as const;

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createApp(): Express {
  const app = express();
  app.set("trust proxy", config.trustProxyHops);
  app.use(cors({ origin: config.frontendUrl, credentials: true }));
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());

  app.get("/health", asyncRoute(async (_request, response) => {
    await Promise.all([
      prisma.$queryRaw`SELECT 1`,
      redis.ping(),
      searchClient.ping(),
    ]);
    response.json({ status: "ok" });
  }));
  const authRateLimit = createRateLimiter(
    "auth",
    config.authRequestsPerMinute,
    60_000,
  );
  const scheduleRateLimit = createRateLimiter(
    "schedule",
    config.scheduleRequestsPerMinute,
    60_000,
    (request) => request.userId ?? request.ip ?? "unknown",
  );
  const readRateLimit = createRateLimiter(
    "read",
    config.readRequestsPerMinute,
    60_000,
    (request) => request.userId ?? request.ip ?? "unknown",
  );

  app.get("/auth/google", authRateLimit, asyncRoute(beginGoogleLogin));
  app.get("/auth/google/callback", authRateLimit, asyncRoute(finishGoogleLogin));
  app.post("/auth/logout", logout);

  app.get("/auth/slack", authRateLimit, requireAuth, (request, response) => {
    if (!config.slackClientId || !config.slackClientSecret) {
      response.status(503).json({ error: "Slack OAuth is not configured" });
      return;
    }
    const state = randomBytes(24).toString("hex");
    response.cookie("slack_oauth_state", state, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "lax",
      maxAge: 10 * 60 * 1000,
      path: "/",
    });
    const parameters = new URLSearchParams({
      client_id: config.slackClientId,
      scope: "chat:write,im:write",
      redirect_uri: config.slackCallbackUrl,
      state,
    });
    response.redirect(`https://slack.com/oauth/v2/authorize?${parameters.toString()}`);
  });

  app.get("/auth/slack/callback", authRateLimit, requireAuth, asyncRoute(async (request, response) => {
    const cookieState = request.cookies.slack_oauth_state as string | undefined;
    response.clearCookie("slack_oauth_state", { path: "/" });
    const queryState = typeof request.query.state === "string" ? request.query.state : "";
    if (!cookieState || !queryState || !safeEqual(cookieState, queryState)) {
      response.redirect(`${config.frontendUrl}/?error=Slack%20connection%20state%20was%20invalid`);
      return;
    }
    if (typeof request.query.code !== "string") {
      response.redirect(`${config.frontendUrl}/?error=Slack%20did%20not%20return%20an%20authorization%20code`);
      return;
    }
    const account = await exchangeSlackCode(request.query.code);
    await prisma.slackConnection.upsert({
      where: { userId: requireUserId(request) },
      create: {
        userId: requireUserId(request),
        accessToken: encryptToken(account.token),
        slackUserId: account.slackUserId,
        teamName: account.teamName,
      },
      update: {
        accessToken: encryptToken(account.token),
        slackUserId: account.slackUserId,
        teamName: account.teamName,
        connectedAt: new Date(),
      },
    });
    response.redirect(`${config.frontendUrl}/?slack=connected`);
  }));

  app.get("/api/me", requireAuth, readRateLimit, asyncRoute(async (request, response) => {
    const user = await prisma.user.findUnique({
      where: { id: requireUserId(request) },
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        slackConnection: { select: { teamName: true, connectedAt: true } },
      },
    });
    if (!user) {
      response.status(401).json({ error: "User account no longer exists" });
      return;
    }
    response.json(user);
  }));

  app.get("/api/senders", requireAuth, readRateLimit, (_request, response) => {
    response.json({
      senders: Array.from(config.senders.values()).map(({ email, name }) => ({ email, name })),
      defaultHourlyLimit: config.defaultMaxEmailsPerHour,
      minDelayBetweenEmailsMs: config.minDelayBetweenEmailsMs,
    });
  });

  app.delete("/api/slack", authRateLimit, requireAuth, asyncRoute(async (request, response) => {
    await prisma.slackConnection.deleteMany({ where: { userId: requireUserId(request) } });
    response.status(204).end();
  }));

  app.post("/api/emails", requireAuth, scheduleRateLimit, asyncRoute(async (request, response) => {
    const keyHeader = request.header("Idempotency-Key");
    if (!keyHeader || keyHeader.length > 200) {
      response.status(400).json({ error: "A valid Idempotency-Key header is required" });
      return;
    }
    const parsed = scheduleSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Invalid schedule request",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }
    const input = parsed.data;
    const userId = requireUserId(request);
    const sender = config.senders.get(input.senderEmail.toLowerCase());
    if (!sender) {
      response.status(400).json({ error: "Selected sender is not configured on this server" });
      return;
    }

    const idempotencyKey = `${userId}:${keyHeader}`;
    const requestHash = createScheduleRequestHash(input, sender.email);
    let emailIds: string[];
    const existing = await prisma.scheduleRequest.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        response.status(409).json({ error: "Idempotency-Key was already used for a different request" });
        return;
      }
      emailIds = existing.resultIds;
    } else {
      const startAt = new Date(input.startAt);
      const ids = input.recipients.map(() => randomUUID());
      try {
        await prisma.$transaction(async (transaction) => {
          await transaction.scheduleRequest.create({
            data: { idempotencyKey, userId, requestHash, resultIds: ids },
          });
          await transaction.emailJob.createMany({
            data: input.recipients.map((recipient, index) => ({
              id: ids[index],
              userId,
              senderEmail: sender.email,
              recipient: recipient.toLowerCase(),
              subject: input.subject,
              body: input.body,
              scheduledAt: new Date(startAt.getTime() + index * input.delayMs),
              hourlyLimit: input.hourlyLimit,
              delayMs: input.delayMs,
            })),
          });
        });
        emailIds = ids;
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
          throw error;
        }
        const duplicate = await prisma.scheduleRequest.findUnique({ where: { idempotencyKey } });
        if (!duplicate) throw error;
        if (duplicate.requestHash !== requestHash) {
          response.status(409).json({ error: "Idempotency-Key was already used for a different request" });
          return;
        }
        emailIds = duplicate.resultIds;
      }

    }

    const persisted = await prisma.emailJob.findMany({
      where: { id: { in: emailIds }, userId },
    });
    const requestOrder = new Map(emailIds.map((id, index) => [id, index]));
    persisted.sort((left, right) =>
      (requestOrder.get(left.id) ?? 0) - (requestOrder.get(right.id) ?? 0),
    );
    try {
      await emailQueue.addBulk(
        persisted.map((email) => ({
          name: "send-email",
          data: {
            emailJobId: email.id,
            userId,
            senderEmail: email.senderEmail,
            recipient: email.recipient,
            subject: email.subject,
            body: email.body,
            hourlyLimit: email.hourlyLimit,
            delayMs: email.delayMs,
          } satisfies EmailTask,
          opts: {
            jobId: email.id,
            delay: Math.max(email.scheduledAt.getTime() - Date.now(), 0),
          },
        })),
      );
      await indexEmails(persisted);
    } catch (error) {
      console.error("Email was persisted but queue or search indexing failed:", error);
      response.status(503).json({
        error: "Some emails were saved, but scheduling or search indexing needs attention. Retry with the same Idempotency-Key.",
      });
      return;
    }

    const persistedById = new Map(
      (await prisma.emailJob.findMany({
        where: { id: { in: emailIds }, userId },
        select: emailListSelect,
      })).map((email) => [email.id, email]),
    );
    const emails = emailIds
      .map((id) => persistedById.get(id))
      .filter((email) => email !== undefined);
    response.status(202).json({ count: emails.length, emails });
  }));

  app.get("/api/emails", requireAuth, readRateLimit, asyncRoute(async (request, response) => {
    const userId = requireUserId(request);
    const status = typeof request.query.status === "string" ? request.query.status : "scheduled";
    if (!["scheduled", "sent", "failed", "all"].includes(status)) {
      response.status(400).json({ error: "status must be scheduled, sent, failed, or all" });
      return;
    }
    const searchValue = request.query.search;
    if (searchValue !== undefined && typeof searchValue !== "string") {
      response.status(400).json({ error: "search must be a single string" });
      return;
    }
    const search = searchValue?.trim() ?? "";
    if (search.length > 200) {
      response.status(400).json({ error: "search must be 200 characters or fewer" });
      return;
    }
    const pageValue = request.query.page;
    const pageSizeValue = request.query.pageSize;
    if (
      (pageValue !== undefined && typeof pageValue !== "string") ||
      (pageSizeValue !== undefined && typeof pageSizeValue !== "string")
    ) {
      response.status(400).json({ error: "page and pageSize must be single numbers" });
      return;
    }
    const page = pageValue === undefined ? 1 : Number(pageValue);
    const pageSize = pageSizeValue === undefined ? 50 : Number(pageSizeValue);
    if (
      !Number.isSafeInteger(page) || page < 1 || page > 1_000_000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    ) {
      response.status(400).json({ error: "page must be 1–1000000 and pageSize must be 1–100" });
      return;
    }
    const statuses =
      status === "scheduled" ? ["scheduled", "sending"] :
      status === "sent" ? ["sent", "failed"] :
      status === "failed" ? ["failed"] : undefined;
    const where = {
      userId,
      ...(statuses ? { status: { in: statuses } } : {}),
    };

    if (search) {
      const result = await searchClient.search({
        index: config.elasticsearchIndex,
        from: (page - 1) * pageSize,
        size: pageSize,
        query: {
          bool: {
            filter: [
              { term: { userId } },
              ...(statuses ? [{ terms: { status: statuses } }] : []),
            ],
            must: [{
              multi_match: {
                query: search,
                fields: ["recipient", "senderEmail", "subject"],
                type: "best_fields",
              },
            }],
          },
        },
        sort: [{ scheduledAt: "desc" }],
      });
      const hits = result.hits.hits;
      const ids = hits.map((hit) => hit._id).filter((id): id is string => Boolean(id));
      const rows = await prisma.emailJob.findMany({
        where: { ...where, id: { in: ids } },
        select: emailListSelect,
      });
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      const orderedRows = ids.map((id) => rowsById.get(id)).filter((row) => row !== undefined);
      response.json({
        emails: orderedRows,
        total: typeof result.hits.total === "number" ? result.hits.total : result.hits.total?.value ?? 0,
        page,
        pageSize,
      });
      return;
    }

    const [emails, total] = await prisma.$transaction([
      prisma.emailJob.findMany({
        where,
        orderBy: { scheduledAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: emailListSelect,
      }),
      prisma.emailJob.count({ where }),
    ]);
    response.json({ emails, total, page, pageSize });
  }));

  if (config.bullBoardPassword) {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath("/admin/queues");
    createBullBoard({
      queues: [new BullMQAdapter(emailQueue)],
      serverAdapter,
    });
    app.use(
      "/admin/queues",
      requireBullBoardAuth,
      serverAdapter.getRouter(),
    );
  } else {
    app.get("/admin/queues", (_request, response) => {
      response.status(503).send("Configure BULL_BOARD_PASSWORD to enable the queue dashboard.");
    });
  }

  function requireBullBoardAuth(
    request: Request,
    response: Response,
    next: NextFunction,
  ): void {
    const authorization = request.header("authorization") ?? "";
    const encoded = authorization.startsWith("Basic ") ? authorization.slice(6) : "";
    const supplied = Buffer.from(encoded, "base64").toString("utf8");
    if (!safeEqual(supplied, `${config.bullBoardUser}:${config.bullBoardPassword}`)) {
      response.setHeader("WWW-Authenticate", 'Basic realm="Bull Board", charset="UTF-8"');
      response.status(401).send("Authentication required");
      return;
    }
    next();
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error("Unhandled API error:", error);
    if (response.headersSent) return;
    if (typeof error === "object" && error !== null && "type" in error) {
      const errorType = (error as { type?: unknown }).type;
      if (errorType === "entity.parse.failed") {
        response.status(400).json({ error: "Request body contains invalid JSON" });
        return;
      }
      if (errorType === "entity.too.large") {
        response.status(413).json({ error: "Request body is too large" });
        return;
      }
    }
    response.status(500).json({ error: "An unexpected server error occurred" });
  });
  return app;
}
