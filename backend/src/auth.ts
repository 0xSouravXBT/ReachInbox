import { randomBytes, timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config";
import { prisma } from "./db";

const googleClient = new OAuth2Client(
  config.googleClientId,
  config.googleClientSecret,
  config.googleCallbackUrl,
);
const sessionCookie = "reachinbox_session";

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax" as const,
    maxAge,
    path: "/",
  };
}

function redirectError(response: Response, message: string): void {
  response.redirect(`${config.frontendUrl}/?error=${encodeURIComponent(message)}`);
}

export async function beginGoogleLogin(_request: Request, response: Response): Promise<void> {
  if (!config.googleClientId || !config.googleClientSecret) {
    redirectError(response, "Google login is not configured");
    return;
  }
  const state = randomBytes(24).toString("hex");
  response.cookie("google_oauth_state", state, cookieOptions(10 * 60 * 1000));
  response.redirect(
    googleClient.generateAuthUrl({
      access_type: "online",
      scope: ["openid", "email", "profile"],
      state,
      prompt: "select_account",
    }),
  );
}

export async function finishGoogleLogin(request: Request, response: Response): Promise<void> {
  const cookieState = request.cookies.google_oauth_state as string | undefined;
  response.clearCookie("google_oauth_state", { path: "/" });
  const queryState = typeof request.query.state === "string" ? request.query.state : "";
  if (!cookieState || !queryState || !safeEqual(cookieState, queryState)) {
    redirectError(response, "Google login state was invalid; please try again");
    return;
  }
  if (typeof request.query.code !== "string") {
    redirectError(response, "Google did not return an authorization code");
    return;
  }

  try {
    const { tokens } = await googleClient.getToken(request.query.code);
    if (!tokens.id_token) throw new Error("Google did not return an ID token");
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.googleClientId,
    });
    const profile = ticket.getPayload();
    if (!profile?.sub || !profile.email || !profile.email_verified) {
      throw new Error("Google account did not provide a verified email");
    }

    const user = await prisma.user.upsert({
      where: { googleId: profile.sub },
      create: {
        googleId: profile.sub,
        email: profile.email,
        name: profile.name ?? profile.email,
        avatar: profile.picture,
      },
      update: {
        email: profile.email,
        name: profile.name ?? profile.email,
        avatar: profile.picture,
      },
    });
    const token = jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: "7d" });
    response.cookie(sessionCookie, token, cookieOptions(7 * 24 * 60 * 60 * 1000));
    response.redirect(config.frontendUrl);
  } catch (error) {
    console.error("Google OAuth failed:", error);
    redirectError(response, "Google login failed; please try again");
  }
}

export function requireAuth(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const token = request.cookies[sessionCookie] as string | undefined;
  if (!token) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload === "string" || typeof payload.sub !== "string") {
      throw new Error("Invalid session token");
    }
    request.userId = payload.sub;
    next();
  } catch {
    response.clearCookie(sessionCookie, { path: "/" });
    response.status(401).json({ error: "Session expired; please sign in again" });
  }
}

export function logout(_request: Request, response: Response): void {
  response.clearCookie(sessionCookie, { path: "/" });
  response.status(204).end();
}

export function requireUserId(request: Request): string {
  if (!request.userId) throw new Error("Authenticated request has no user id");
  return request.userId;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}
