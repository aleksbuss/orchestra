/**
 * Contract for the production server's bind address (PM #140).
 *
 * A fresh install accepts `admin`/`admin` until its first login, so "listen on
 * every interface" — Next's default for `next start` — lets a LAN neighbour be
 * the first to sign in. `npm run start` therefore binds 127.0.0.1 unless the
 * operator opts in through ORCHESTRA_BIND_HOST. The container is the one place
 * that MUST listen on every interface (the published port reaches it over the
 * bridge), and its host-side exposure is limited separately by APP_BIND_HOST in
 * docker-compose.yml.
 *
 * The container path cannot be exercised in a unit test, so this pins the three
 * pieces that make it work — and the shell expansion the script relies on.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("production bind address (PM #140)", () => {
  it("`npm run start` binds loopback unless ORCHESTRA_BIND_HOST opts in", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toBe("next start -H ${ORCHESTRA_BIND_HOST:-127.0.0.1}");
  });

  it("the container image listens on every interface (otherwise the published port is dead)", () => {
    const dockerfile = read("Dockerfile");
    const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(runner).toMatch(/^ENV ORCHESTRA_BIND_HOST=0\.0\.0\.0$/m);
  });

  it("compose still publishes on the host's loopback by default", () => {
    expect(read("docker-compose.yml")).toContain(
      '"${APP_BIND_HOST:-127.0.0.1}:${APP_PORT:-3000}:3000"'
    );
  });

  it.skipIf(process.platform === "win32")(
    "the script's expansion yields loopback by default and honours the override",
    () => {
      const expand = (env: Record<string, string>) =>
        execFileSync("sh", ["-c", "printf %s ${ORCHESTRA_BIND_HOST:-127.0.0.1}"], {
          // Next's typings make NODE_ENV a required member of ProcessEnv.
          env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
          encoding: "utf8",
        });
      expect(expand({})).toBe("127.0.0.1");
      expect(expand({ ORCHESTRA_BIND_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    }
  );
});
