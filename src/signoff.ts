import { readFileSync } from "node:fs";

/** What vouches for a slot that Lightbringer delivered. */
export type Signoff = "alpenglow-cert" | "rpc-confirmed" | "none";

const MODE_TO_SIGNOFF: Record<string, Signoff> = {
  alpenglow: "alpenglow-cert",
  rpc: "rpc-confirmed",
};

/**
 * Reads the sign-off out of the node's own config rather than trusting a flag.
 * Lightbringer gates its stream on the configured block-confirmation mode, so the
 * config is what decides whether a delivered slot carries a proof at all: with no
 * [block_confirmation] section every reassembled slot is emitted and nothing has
 * vouched for it. Throws when the section names a mode this does not know.
 */
export function readSignoff(configPath: string): Signoff {
  const toml = readFileSync(configPath, "utf8");
  const section = toml.split(/^\s*\[block_confirmation\]\s*$/m)[1];
  if (section === undefined) {
    return "none";
  }

  const body = section.split(/^\s*\[/m)[0] ?? "";
  const mode = body.match(/^\s*mode\s*=\s*"([^"]+)"/m)?.[1];
  if (mode === undefined) {
    return "none";
  }

  const signoff = MODE_TO_SIGNOFF[mode];
  if (signoff === undefined) {
    throw new Error(`unknown block_confirmation mode ${mode} in ${configPath}`);
  }
  return signoff;
}
