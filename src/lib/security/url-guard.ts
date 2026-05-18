/**
 * SSRF guard for user-supplied URLs that the server is about to fetch.
 *
 * Rules (deliberate):
 *   - Protocol must be http: or https: (rejects javascript:, file:, data:).
 *   - Loopback (127.0.0.0/8, ::1, localhost) is INTENTIONALLY allowed.
 *     Local services like Ollama on `http://localhost:11434` are a primary
 *     legitimate use case for this product; blocking them would break the
 *     local-first model.
 *   - RFC 1918 private ranges, link-local (169.254.0.0/16 — covers AWS/GCP/
 *     Azure metadata endpoints), and IPv6 ULA / link-local are REJECTED.
 *
 * Residual risk (carried as caveat in POST_MORTEMS.md PM #8):
 *   - DNS rebinding: a hostname that resolves to a public IP at validation
 *     time and a private IP at fetch time will bypass this guard. A complete
 *     fix requires resolving the host once and pinning the IP for fetch.
 *     Mitigation accepted for a local-first single-operator threat model.
 *   - Loopback scan: `localhost:6379` (or any other local service) is still
 *     reachable. Real defense for that is route auth + CSRF tokens.
 *   - Pure-hex IPv6 encodings of private IPv4 (e.g. `[::a9fe:a9fe]` for
 *     169.254.169.254) bypass this guard — we only catch the dotted-quad
 *     IPv4-in-IPv6 forms (`::ffff:a.b.c.d`, `::a.b.c.d`) that off-the-shelf
 *     scanners use. A full fix requires parsing IPv6 to canonical bytes
 *     and checking the last 32 bits against IPv4 ranges. Acceptable for
 *     the local-first threat model; revisit if exposed to untrusted nets.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * IPv4-in-IPv6 forms that Node's resolver translates to a plain IPv4 address:
 *   - `::ffff:a.b.c.d` (IPv4-mapped, RFC 4291) — the realistic bypass vector
 *   - `::a.b.c.d`      (IPv4-compatible, RFC 4291 §2.5.5.1, deprecated but
 *                       still resolvable)
 *
 * The WHATWG URL parser that Node uses NORMALIZES the dotted-quad form to
 * pure hex before our guard sees it: `[::ffff:169.254.169.254]` arrives as
 * `[::ffff:a9fe:a9fe]`. So this regex matches the hex form (two 16-bit
 * groups carrying the upper and lower halves of the embedded IPv4). Leading
 * zeros are stripped by the parser, so each group is 1–4 hex chars.
 *
 * Without this check, `[::ffff:169.254.169.254]` reached cloud metadata
 * because the IPv4 regex didn't match (colons) and the IPv6 prefix list
 * didn't include `::`. Discovered during the 2026-05 audit (PM #8 follow-up).
 */
const IPV4_IN_IPV6_HEX_RE = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/**
 * Decode `::ffff:HHHH:LLLL` (or `::HHHH:LLLL`) to dotted-quad IPv4.
 * Returns `null` if `host` isn't an IPv4-in-IPv6 form.
 */
function extractEmbeddedIPv4(host: string): string | null {
  const m = IPV4_IN_IPV6_HEX_RE.exec(host);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateOrLinkLocalIPv4(host: string): boolean {
  const m = IPV4_RE.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((octet) => octet < 0 || octet > 255)) return false;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local; covers AWS/GCP/Azure metadata at 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 — "this network" — never legitimate as an outbound target
  if (a === 0) return true;
  return false;
}

function isPrivateOrLinkLocalIPv6(host: string): boolean {
  // Node's URL.hostname keeps the surrounding brackets for IPv6 literals
  // (e.g. "[fc00::1]"). Strip them before pattern-matching.
  const lower = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

  // IPv4-in-IPv6 form: defer to the IPv4 check on the embedded address.
  // Loopback (e.g. `::ffff:127.0.0.1` → `::ffff:7f00:1`) intentionally
  // falls through here because `isPrivateOrLinkLocalIPv4` doesn't list
  // 127/8 — matching the module's loopback-allowed policy.
  const embeddedIPv4 = extractEmbeddedIPv4(lower);
  if (embeddedIPv4 && isPrivateOrLinkLocalIPv4(embeddedIPv4)) {
    return true;
  }

  // Unique-local (fc00::/7)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // Link-local (fe80::/10) — covers fe80–febf
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true;
  }
  // Loopback (::1) is intentionally allowed (matches IPv4 loopback policy).
  return false;
}

export class UnsafeOutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutboundUrlError";
  }
}

/**
 * Validates that `rawUrl` is safe for the server to fetch on behalf of a
 * client. Returns the parsed URL if safe; throws `UnsafeOutboundUrlError`
 * otherwise. See module-level docstring for the policy.
 */
export function assertSafeOutboundUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeOutboundUrlError("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeOutboundUrlError(
      `Disallowed protocol: ${parsed.protocol}`
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new UnsafeOutboundUrlError("URL is missing a host");
  }
  if (isPrivateOrLinkLocalIPv4(host)) {
    throw new UnsafeOutboundUrlError(
      `Blocked private/link-local IPv4 host: ${host}`
    );
  }
  if (isPrivateOrLinkLocalIPv6(host)) {
    throw new UnsafeOutboundUrlError(
      `Blocked private/link-local IPv6 host: ${host}`
    );
  }
  return parsed;
}
