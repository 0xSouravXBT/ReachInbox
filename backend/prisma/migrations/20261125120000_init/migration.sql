CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "googleId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "hourlyLimit" INTEGER NOT NULL,
    "delayMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScheduleRequest" (
    "idempotencyKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "resultIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScheduleRequest_pkey" PRIMARY KEY ("idempotencyKey")
);

CREATE TABLE "SlackConnection" (
    "userId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SlackConnection_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "EmailJob_userId_status_scheduledAt_idx" ON "EmailJob"("userId", "status", "scheduledAt");
CREATE INDEX "EmailJob_senderEmail_scheduledAt_idx" ON "EmailJob"("senderEmail", "scheduledAt");
CREATE UNIQUE INDEX "ScheduleRequest_userId_idempotencyKey_key" ON "ScheduleRequest"("userId", "idempotencyKey");

ALTER TABLE "EmailJob" ADD CONSTRAINT "EmailJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleRequest" ADD CONSTRAINT "ScheduleRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SlackConnection" ADD CONSTRAINT "SlackConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
