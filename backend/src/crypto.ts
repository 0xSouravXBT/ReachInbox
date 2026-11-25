import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config";

export function encryptToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.tokenEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64")).join(".");
}

export function decryptToken(value: string): string {
  const [iv, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part, "base64"));
  if (!iv || !tag || !ciphertext) throw new Error("Stored Slack token is malformed");
  const decipher = createDecipheriv("aes-256-gcm", config.tokenEncryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
