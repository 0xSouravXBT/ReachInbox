import assert from "node:assert/strict";
import test from "node:test";
import { parseLeadText } from "../frontend/src/leads";
import {
  createScheduleRequestHash,
  scheduleSchema,
} from "../backend/src/scheduleSchema";

const validSchedule = {
  senderEmail: "sender@example.test",
  subject: "Hello",
  body: "A message",
  recipients: ["lead@example.test"],
  startAt: "2026-12-01T10:00:00.000Z",
  delayMs: 2000,
  hourlyLimit: 100,
};

test("schedule validation rejects invalid recipients and out-of-range controls", () => {
  assert.equal(scheduleSchema.safeParse(validSchedule).success, true);
  assert.equal(
    scheduleSchema.safeParse({ ...validSchedule, recipients: ["invalid"] }).success,
    false,
  );
  assert.equal(scheduleSchema.safeParse({ ...validSchedule, delayMs: -1 }).success, false);
  assert.equal(scheduleSchema.safeParse({ ...validSchedule, hourlyLimit: 0 }).success, false);
});

test("idempotency hashes canonicalize address case and equivalent timestamps", () => {
  const first = scheduleSchema.parse(validSchedule);
  const retry = scheduleSchema.parse({
    ...validSchedule,
    recipients: ["LEAD@example.test"],
    startAt: "2026-12-01T05:00:00.000-05:00",
  });

  assert.equal(
    createScheduleRequestHash(first, "sender@example.test"),
    createScheduleRequestHash(retry, "sender@example.test"),
  );
  assert.notEqual(
    createScheduleRequestHash(first, "sender@example.test"),
    createScheduleRequestHash({ ...first, subject: "Different" }, "sender@example.test"),
  );
});

test("lead parsing deduplicates addresses and excludes malformed candidates", () => {
  assert.deepEqual(parseLeadText(
    "Alex <alex@example.com>, ALEX@example.com; invalid@@example.com",
  ), {
    recipients: ["alex@example.com"],
    invalidCount: 1,
    duplicatesRemoved: 1,
  });
});
