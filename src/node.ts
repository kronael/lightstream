import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface NodeOptions {
  binary: string;
  gossipEntrypoint: string;
  storage: string;
  grpcAddr: string;
  /** Omitted leaves the stream ungated: every reassembled slot, nothing vouching. */
  mode?: "alpenglow";
  snapshotSource?: string;
  /**
   * The cluster's JSON-RPC, used for the leader schedule every shred is checked
   * against. Lightbringer defaults it to the Alpenglow test cluster, whose schedule
   * matches no mainnet shred, so alpenglow mode must always set it explicitly.
   */
  rpcHttp?: string;
  workDir: string;
}

/**
 * Writes Lightbringer.toml into `workDir`, where the node reads it from, and
 * returns its path. Synchronous on purpose: the caller spawns a node that reads
 * the file immediately.
 */
export function writeConfig(options: NodeOptions): string {
  const lines = [
    `gossip_entrypoint = "${options.gossipEntrypoint}"`,
    `storage = "${options.storage}"`,
    `grpc_addr = "${options.grpcAddr}"`,
    "",
    "[gossip]",
    "gossip_port = 65400",
    "port_range_start = 65401",
    "port_range_end = 65500",
  ];
  if (options.mode === "alpenglow") {
    lines.push("", "[block_confirmation]", 'mode = "alpenglow"');
    if (options.rpcHttp !== undefined) {
      lines.push(`rpc_http = "${options.rpcHttp}"`);
    }
    if (options.snapshotSource !== undefined) {
      lines.push(`snapshot_source = "${options.snapshotSource}"`);
    }
  }

  const path = join(options.workDir, "Lightbringer.toml");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/**
 * Spawns the node and takes ownership of its lifetime: it is killed on every
 * exit path of this process, including a thrown error. A stray node holds the
 * gossip identity and the shred store's lock, which blocks the next start.
 */
export function spawnNode(options: NodeOptions): Bun.Subprocess {
  const proc = Bun.spawn([options.binary], {
    cwd: options.workDir,
    stdout: "inherit",
    stderr: "inherit",
    onExit: (_proc, code) => console.error(`lightbringer exited with code ${code}`),
  });
  process.on("exit", () => proc.kill());
  return proc;
}

/** Resolves once the node accepts connections, or throws when it never does. */
export async function waitForGrpc(addr: string, timeoutMs = 120_000): Promise<void> {
  const [host = "127.0.0.1", port = "3001"] = addr.split(":");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await Bun.connect({
      hostname: host,
      port: Number(port),
      socket: { data() {} },
    })
      .then((socket) => {
        socket.end();
        return true;
      })
      .catch(() => false);
    if (open) {
      return;
    }
    await Bun.sleep(500);
  }
  throw new Error(`lightbringer did not open ${addr} within ${timeoutMs / 1000}s`);
}
