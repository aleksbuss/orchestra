import { NextRequest } from "next/server";
import {
  connectProviderAuth,
  type CliProvider,
} from "@/lib/providers/provider-auth";
import type { ChatAuthMethod } from "@/lib/types";

function isCliProvider(value: string): value is CliProvider {
  return value === "codex-cli" || value === "gemini-cli";
}

function isAuthMethod(value: string): value is ChatAuthMethod {
  return value === "api_key" || value === "oauth";
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      provider?: string;
      method?: string;
      apiKey?: string;
    };

    const provider = (body.provider || "").trim();
    const method = (body.method || "").trim();

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

    const result = await connectProviderAuth({
      provider,
      method,
      apiKey: body.apiKey,
    });

    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to connect provider auth",
      },
      { status: 500 }
    );
  }
}
