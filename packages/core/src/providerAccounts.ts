import type { ProviderDriver } from "./types.js";

// Each harness account is a provider instance. The seeded `<driver>-local`
// instance is the original account and keeps the unscoped secret names, so
// existing credentials need no migration; every added account stores its
// credentials under `<secret>@<instance id>`.

export const PROVIDER_DRIVERS: ProviderDriver[] = ["codex", "claude", "cursor", "opencode", "devin"];

export const PROVIDER_DRIVER_LABELS: Record<ProviderDriver, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  devin: "Devin"
};

export function defaultProviderInstanceId(driver: ProviderDriver): string {
  return `${driver}-local`;
}

export function isDefaultProviderInstance(instanceId: string | null | undefined): boolean {
  return !instanceId || PROVIDER_DRIVERS.some((driver) => defaultProviderInstanceId(driver) === instanceId);
}

export function providerInstanceSecretName(baseName: string, instanceId: string | null | undefined): string {
  return isDefaultProviderInstance(instanceId) ? baseName : `${baseName}@${instanceId}`;
}

/** A new account's instance id: `<driver>-<slug>`, never colliding with the default id. */
export function newProviderInstanceId(driver: ProviderDriver, label: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "account";
  let candidate = `${driver}-${slug === "local" ? "account" : slug}`;
  for (let index = 2; taken.has(candidate); index += 1) candidate = `${driver}-${slug}-${index}`;
  return candidate;
}
