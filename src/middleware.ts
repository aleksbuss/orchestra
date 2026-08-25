import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";

// Escape hatch for local development and forgotten-password recovery.
// When set to "true", middleware skips all auth checks — every request is
// treated as fully authenticated. Set via .env.local; requires server restart.
// Never enable this in a deployment reachable from untrusted networks.
function isAuthDisabledByEnv(): boolean {
  return process.env.ORCHESTRA_DISABLE_AUTH === "true";
}

function isPublicPage(pathname: string): boolean {
  return pathname === "/login";
}

function isPublicApi(req: NextRequest, pathname: string): boolean {
  if (pathname === "/api/health") return true;
  if (pathname === "/api/auth/login") return true;
  if (pathname === "/api/auth/logout") return true;
  if (pathname === "/api/auth/status") return true;
  if (pathname === "/api/external/message") return true;
  if (pathname === "/api/integrations/telegram" && req.method === "POST") {
    return true;
  }
  return false;
}

function shouldBypass(pathname: string): boolean {
  // Framework and well-known static paths — never application routes.
  if (
    pathname.startsWith("/_next/static") ||
    pathname.startsWith("/_next/image") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  ) {
    return true;
  }

  // Everything under `/api/` and `/dashboard` is an APPLICATION route and is
  // never exempt, whatever its spelling.
  //
  // This clause is the fix for an unauthenticated data disclosure found on
  // 2026-08-25. The "looks like a static file" test below used to run FIRST and
  // over the whole path, so any request whose last segment contained a dot
  // skipped every auth check:
  //
  //   GET /api/debug/chat/foo         → 401   (correct)
  //   GET /api/debug/chat/foo.json    → 200   (auth skipped entirely)
  //
  // That is not theoretical. `POST /api/chat` accepts a caller-supplied
  // `chatId`, so a chat can legitimately be created as `notes.private`; an
  // anonymous `GET /api/debug/chat/notes.private` then returned its title,
  // message count, and `lastMessage.contentPreview` — the message text —
  // from an endpoint whose own header says it "reads chat state, recent logs
  // (potentially containing sensitive context), and daemon internals — not
  // something to expose anonymously". Reproduced end-to-end before this change.
  //
  // The same spelling trick also reached `/dashboard/*`, and url-encoded
  // traversal (`..%2f..%2fx`) matched the regex for the same reason: `%2f` is
  // not a literal `/`, so the "extension" ran to the end of the path.
  if (pathname.startsWith("/api/") || pathname.startsWith("/dashboard")) {
    return false;
  }

  // Root-level assets served out of `public/` (`/logo.png`, `/manifest.json`).
  // Only reachable now that application routes are excluded above.
  if (/\.[^/]+$/.test(pathname)) {
    return true;
  }
  return false;
}

function buildLoginRedirect(req: NextRequest): NextResponse {
  const loginUrl = new URL("/login", req.url);
  const next = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (next && next !== "/") {
    loginUrl.searchParams.set("next", next);
  }
  return NextResponse.redirect(loginUrl);
}

function buildCredentialsOnboardingRedirect(req: NextRequest): NextResponse {
  const url = new URL("/dashboard/projects", req.url);
  url.searchParams.set("onboarding", "1");
  url.searchParams.set("credentials", "1");
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (shouldBypass(pathname)) {
    return NextResponse.next();
  }

  // Auth fully disabled — every request passes, but /login still redirects to
  // /dashboard (no reason to show a login form that does nothing).
  if (isAuthDisabledByEnv()) {
    if (isPublicPage(pathname)) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    if (pathname === "/") {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/") && isPublicApi(req, pathname)) {
    return NextResponse.next();
  }

  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value || "";
  const session = token ? await verifySessionToken(token) : null;

  if (isPublicPage(pathname)) {
    if (session) {
      if (session.mustChangeCredentials) {
        return buildCredentialsOnboardingRedirect(req);
      }
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return NextResponse.next();
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return buildLoginRedirect(req);
  }

  if (
    session.mustChangeCredentials &&
    pathname.startsWith("/dashboard") &&
    pathname !== "/dashboard/projects"
  ) {
    return buildCredentialsOnboardingRedirect(req);
  }

  if (
    session.mustChangeCredentials &&
    pathname === "/dashboard/projects" &&
    req.nextUrl.searchParams.get("credentials") !== "1"
  ) {
    return buildCredentialsOnboardingRedirect(req);
  }

  // Mirror the dashboard gate on the API surface. Without this, a session
  // logged in as default admin/admin (post `npm run auth:reset`) can hit every
  // /api/* endpoint before the operator changes the password — a same-origin
  // fetch from any localhost page would act as admin. Only the credentials-
  // change and logout endpoints are kept reachable so the UI flow can recover.
  if (
    session.mustChangeCredentials &&
    pathname.startsWith("/api/") &&
    pathname !== "/api/auth/credentials" &&
    pathname !== "/api/auth/logout"
  ) {
    return Response.json(
      { error: "Must change default credentials before using the API." },
      { status: 403 }
    );
  }

  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/:path*"],
};
