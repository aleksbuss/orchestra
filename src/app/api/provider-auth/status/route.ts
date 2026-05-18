import { NextRequest } from "next/server";
import {
  checkProviderAuthStatus,
  type CliProvider,
} from "@/lib/providers/provider-auth";
import type { ChatAuthMethod } from "@/lib/types";

function isCliProvider(value: string): value is CliProvider {
  return value === "codex-cli" || value === "gemini-cli";
}

function isAuthMethod(value: string): value is ChatAuthMethod {
  return value === "api_key" || value === "oauth";
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const provider = searchParams.get("provider") || "";
    const method = searchParams.get("method") || "";
    const hasApiKeyRaw = searchParams.get("hasApiKey");

    if (!isCliProvider(provider)) {
      return Response.json(
        { error: "provider must be one of: codex-cli, gemini-cli" },
        { status: 400 }
      );
    }
    if (!isAuthMethod(method)) {
      return Response.json(
        { error: "method must be one of: api_key, oauth" },
        { status: 400 }
      );
    }
    if (method !== "oauth") {
      return Response.json(
        {
          error:
            provider === "codex-cli"
              ? "codex-cli supports only oauth in Orchestra settings"
              : "gemini-cli supports only oauth in Orchestra settings",
        },
        { status: 400 }
      );
    }

    const hasApiKey =
      hasApiKeyRaw === "1" ||
      hasApiKeyRaw === "true" ||
      hasApiKeyRaw === "yes";

    const status = await checkProviderAuthStatus({
      provider,
      method,
      hasApiKey,
    });

    return Response.json(status);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to check status",
      },
      { status: 500 }
    );
  }
}
