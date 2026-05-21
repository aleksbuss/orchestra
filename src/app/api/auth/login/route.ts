import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/storage/settings-store";
import {
  isDefaultAuthCredentials,
  verifyPassword,
} from "@/lib/auth/password";
import {
  AUTH_COOKIE_NAME,
  createSessionToken,
  getSessionCookieOptionsForRequest,
  isRequestSecure,
} from "@/lib/auth/session";
import {
  clientIpFromRequest,
  recordLoginOutcome,
  shouldAllowLoginAttempt,
} from "@/lib/auth/rate-limit";

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(req: NextRequest) {
  try {
    // Auth fully disabled via env (e.g. local dev, password recovery).
    // Middleware already bypasses session checks, but a stray POST to this
    // route should still resolve cleanly instead of returning a confusing 401.
    if (process.env.ORCHESTRA_DISABLE_AUTH === "true") {
      return Response.json({ success: true, mustChangeCredentials: false });
    }

    const ip = clientIpFromRequest(req);
    const decision = shouldAllowLoginAttempt(ip);
    if (!decision.allowed) {
      return Response.json(
        {
          error: "Too many failed login attempts. Try again later.",
          retryAfterSeconds: decision.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(decision.retryAfterSeconds ?? 60),
          },
        }
      );
    }

    const body = (await req.json()) as LoginBody;
    const username = toTrimmedString(body.username);
    const password = toTrimmedString(body.password);

    if (!username || !password) {
      // Bad request — don't count toward bruteforce budget. Missing fields are
      // user error, not a credential test.
      return Response.json(
        { error: "Username and password are required." },
        { status: 400 }
      );
    }

    const settings = await getSettings();
    if (!settings.auth.enabled) {
      return Response.json(
        { error: "Authentication is disabled." },
        { status: 403 }
      );
    }

    const userMatches = username === settings.auth.username;
    const passwordMatches = verifyPassword(password, settings.auth.passwordHash);
    if (!userMatches || !passwordMatches) {
      recordLoginOutcome(ip, "failure");
      return Response.json({ error: "Invalid credentials." }, { status: 401 });
    }

    recordLoginOutcome(ip, "success");

    const mustChangeCredentials = isDefaultAuthCredentials(
      settings.auth.username,
      settings.auth.passwordHash
    );
    const token = await createSessionToken(username, mustChangeCredentials);
    const response = NextResponse.json({
      success: true,
      mustChangeCredentials,
    });
    response.cookies.set(
      AUTH_COOKIE_NAME,
      token,
      getSessionCookieOptionsForRequest(isRequestSecure(req.url, req.headers))
    );
    return response;
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Login failed.",
      },
      { status: 500 }
    );
  }
}
