import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base58 } from "./base58.ts";
import { readSignoff } from "./signoff.ts";

const fixtures = mkdtempSync(join(tmpdir(), "lightstream-"));

function configFile(name: string, body: string): string {
  const path = join(fixtures, name);
  writeFileSync(path, body);
  return path;
}

/**
 * Bytes with leading zeros encode to that many leading '1' characters, which is
 * base58's only positional special case.
 */
test("base58 encodes leading zero bytes as ones", () => {
  expect(base58(new Uint8Array([0, 0, 1]))).toBe("112");
  expect(base58(new Uint8Array(32))).toBe("1".repeat(32));
});

/** The system program is 32 zero bytes, and Solana renders it as 32 ones. */
test("base58 matches a known Solana pubkey encoding", () => {
  expect(base58(new Uint8Array(32))).toBe("11111111111111111111111111111111");
});

/**
 * A config with no [block_confirmation] section means Lightbringer gates nothing,
 * so every delivered slot is unvouched.
 */
test("a config without a block_confirmation section has no signoff", () => {
  const path = configFile("none.toml", 'storage = "./s"\n\n[log]\nquiet = false\n');
  expect(readSignoff(path)).toBe("none");
});

/** mode = "alpenglow" means the node verified a finalization certificate. */
test("alpenglow mode is a certificate signoff", () => {
  const path = configFile(
    "alpenglow.toml",
    '[block_confirmation]\nmode = "alpenglow"\n\n[log]\nquiet = true\n',
  );
  expect(readSignoff(path)).toBe("alpenglow-cert");
});

/**
 * A mode key belonging to a later section must not be read as the confirmation
 * mode, or an unvouched stream would be reported as verified.
 */
test("a mode key in a later section is not mistaken for the signoff", () => {
  const path = configFile(
    "later.toml",
    '[block_confirmation]\n\n[other]\nmode = "alpenglow"\n',
  );
  expect(readSignoff(path)).toBe("none");
});

/** An unknown mode is a config the operator must fix, not a silent "none". */
test("an unknown block_confirmation mode throws", () => {
  const path = configFile("unknown.toml", '[block_confirmation]\nmode = "gossip"\n');
  expect(() => readSignoff(path)).toThrow(/unknown block_confirmation mode gossip/);
});
