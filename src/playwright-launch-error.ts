const FORMATTED_SANDBOX_MARKER = "Codex/macOS sandbox restriction";
const RAW_SANDBOX_SIGNAL_PATTERNS = [
  "Operation not permitted",
  "Permission denied",
  "MachPortRendezvousServer",
  "bootstrap_check_in",
  "mach_port_rendezvous_mac.cc",
] as const;

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error).replace(/^Error:\s*/, "");
}

export function isPlaywrightSandboxRestrictionError(error: unknown): boolean {
  const message = normalizeErrorMessage(error);
  return message.includes(FORMATTED_SANDBOX_MARKER)
    || (
      message.includes("browserType.launch:")
      && RAW_SANDBOX_SIGNAL_PATTERNS.some((pattern) => message.includes(pattern))
    );
}

export function formatPlaywrightLaunchError(
  error: unknown,
  options: { commandHint?: string } = {},
): string {
  const message = normalizeErrorMessage(error);
  if (!isPlaywrightSandboxRestrictionError(error)) return message;
  if (message.includes(FORMATTED_SANDBOX_MARKER)) return message;

  const hintBody = !options.commandHint
    ? "Re-run outside the Codex sandbox or in CI"
    : /re-?run outside the codex sandbox/i.test(options.commandHint)
      ? options.commandHint
      : `Re-run outside the Codex sandbox or ${options.commandHint}`;
  const hint = ` ${hintBody}.`;

  const originalLine = message.split("\n").find((line) => line.trim().length > 0) ?? message;
  return `Playwright browser launch is blocked by a ${FORMATTED_SANDBOX_MARKER}. Chromium itself is likely fine.${hint}\nOriginal error: ${originalLine}`;
}
