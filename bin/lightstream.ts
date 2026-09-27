import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { inboundPackets, openFirewall, preflight } from "../src/host.ts";
import { type NodeOptions, spawnNode, waitForGrpc, writeConfig } from "../src/node.ts";
import { readSignoff, type Signoff } from "../src/signoff.ts";
import { type Slot, shutdownSignal, streamSlots } from "../src/stream.ts";

const USAGE = `lightstream — index Solana transactions from blocks something vouched for

  lightstream preflight [--fix]     can this host receive Turbine?
                                    --fix OPENS THE FIREWALL (inbound UDP)
  lightstream verify [--window 60]  are datagrams actually arriving?
  lightstream run [options]         spawn or attach to Lightbringer, then index

run options:
  --binary <path>        spawn this Lightbringer; omit to attach to a running one
  --entrypoint <host:port>  gossip entrypoint (default entrypoint.mainnet-beta.solana.com:8001)
  --storage <dir>        shred store (default /var/lib/lightbringer)
  --endpoint <host:port> gRPC address (default 127.0.0.1:3001)
  --config <path>        an existing node's config, when attaching
  --snapshot <url>       snapshot source for the Alpenglow rank map
  --rpc <url>            the same cluster's JSON-RPC, for the leader schedule;
                         required with --snapshot
  --db <path>            SQLite file (default ./lightstream.sqlite)
  --accounts <a,b,c>     index only transactions touching these accounts
  --no-db                stream and report, write nothing
  --allow-processed      index blocks nothing vouched for
`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS slots (
    slot INTEGER PRIMARY KEY, parent_slot INTEGER NOT NULL, tx_count INTEGER NOT NULL,
    signoff TEXT NOT NULL, seen_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS txs (
    signature TEXT PRIMARY KEY, slot INTEGER NOT NULL, accounts TEXT NOT NULL,
    signoff TEXT NOT NULL, seen_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS txs_slot ON txs (slot);
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fix: { type: "boolean", default: false },
    window: { type: "string", default: "60" },
    binary: { type: "string" },
    entrypoint: { type: "string", default: "entrypoint.mainnet-beta.solana.com:8001" },
    storage: { type: "string", default: "/var/lib/lightbringer" },
    endpoint: { type: "string", default: "127.0.0.1:3001" },
    config: { type: "string" },
    snapshot: { type: "string" },
    rpc: { type: "string" },
    db: { type: "string", default: "./lightstream.sqlite" },
    accounts: { type: "string" },
    "no-db": { type: "boolean", default: false },
    "allow-processed": { type: "boolean", default: false },
  },
});

interface Index {
  db: Database;
  write: (slot: Slot, signoff: Signoff) => number;
}

function accountFilter(): Set<string> | undefined {
  const accounts = values.accounts
    ?.split(",")
    .map((account) => account.trim())
    .filter((account) => account.length > 0);
  if (accounts === undefined || accounts.length === 0) {
    return undefined;
  }
  return new Set(accounts);
}

function openIndex(path: string): Index {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const insertSlot = db.query(
    `INSERT INTO slots VALUES ($slot, $parent, $count, $signoff, $now)
     ON CONFLICT (slot) DO UPDATE SET parent_slot = excluded.parent_slot,
       tx_count = excluded.tx_count, signoff = excluded.signoff`,
  );
  const insertTx = db.query(
    `INSERT INTO txs VALUES ($sig, $slot, $accounts, $signoff, $now)
     ON CONFLICT (signature) DO UPDATE SET slot = excluded.slot,
       signoff = excluded.signoff`,
  );
  const filter = accountFilter();

  const write = db.transaction((slot: Slot, signoff: Signoff) => {
    const now = Date.now();
    let written = 0;
    for (const tx of slot.txs) {
      if (filter !== undefined && !tx.accountKeys.some((key) => filter.has(key))) {
        continue;
      }
      insertTx.run({
        $sig: tx.signature,
        $slot: slot.slot,
        $accounts: JSON.stringify(tx.accountKeys),
        $signoff: signoff,
        $now: now,
      });
      written++;
    }
    insertSlot.run({
      $slot: slot.slot,
      $parent: slot.parentSlot,
      $count: written,
      $signoff: signoff,
      $now: now,
    });
    return written;
  });
  return { db, write };
}

function nodeOptions(binary: string): NodeOptions {
  const alpenglow =
    values.snapshot === undefined
      ? {}
      : {
          mode: "alpenglow" as const,
          snapshotSource: values.snapshot,
          rpcHttp: values.rpc,
        };
  return {
    binary,
    gossipEntrypoint: values.entrypoint,
    storage: values.storage,
    grpcAddr: values.endpoint,
    ...alpenglow,
    workDir: process.cwd(),
  };
}

async function run(): Promise<void> {
  let configPath = values.config;
  let node: Bun.Subprocess | undefined;

  if (values.snapshot !== undefined && values.rpc === undefined) {
    throw new Error(
      "--snapshot needs --rpc naming the same cluster's JSON-RPC. Without it " +
        "Lightbringer falls back to its own default, the Alpenglow test cluster, " +
        "whose leader schedule matches no mainnet shred — every shred is dropped " +
        "and the stream stays empty with no error.",
    );
  }

  if (values.binary !== undefined) {
    const options = nodeOptions(values.binary);
    configPath = writeConfig(options);
    console.log(`spawning ${values.binary} (config ${configPath})`);
    node = spawnNode(options);
    await waitForGrpc(values.endpoint);
  }
  if (configPath === undefined) {
    throw new Error("attaching needs --config <the running node's Lightbringer.toml>");
  }

  const signoff = readSignoff(configPath);
  if (signoff === "none" && !values["allow-processed"]) {
    throw new Error(
      `${configPath} has no [block_confirmation] section, so every reassembled slot ` +
        `is streamed and nothing vouches for it. Pass --snapshot to verify Alpenglow ` +
        `certificates, or --allow-processed to index unverified blocks.`,
    );
  }

  const index = values["no-db"] ? undefined : openIndex(values.db);
  const target = index === undefined ? "watching" : `indexing into ${values.db}`;
  console.log(`${target} (signoff=${signoff})`);

  let slots = 0;
  let txs = 0;
  let breaks = 0;
  let last: number | undefined;
  const stopping = shutdownSignal(() => node?.kill());

  try {
    for await (const slot of streamSlots(values.endpoint, stopping)) {
      if (last !== undefined && slot.parentSlot !== last) {
        breaks++;
      }
      last = slot.slot;
      slots++;
      txs += index === undefined ? slot.txs.length : index.write(slot, signoff);
      if (slots % 100 === 0) {
        console.log(
          `slot ${slot.slot} | ${slots} slots | ${txs} txs | ${breaks} parent-link breaks`,
        );
      }
    }
  } finally {
    index?.db.close();
    node?.kill();
  }
  console.log(`stopped after ${slots} slots, ${txs} transactions`);
}

async function runPreflight(): Promise<number> {
  if (values.fix) {
    console.log(await openFirewall());
  }
  const checks = await preflight(values.storage);
  for (const check of checks) {
    console.log(`${check.ok ? "OK  " : "FAIL"}  ${check.message}`);
    if (check.detail !== undefined) {
      console.log(`      ${check.detail}`);
    }
  }
  const failed = checks.filter((check) => !check.ok).length;
  if (failed === 0) {
    console.log(`all ${checks.length} checks passed`);
    return 0;
  }
  console.log(`${failed} of ${checks.length} checks failed — fix these and run again`);
  return 1;
}

async function runVerify(): Promise<number> {
  const before = await inboundPackets();
  if (before === undefined) {
    throw new Error("no firewall rule admits the Turbine range; run: preflight --fix");
  }
  console.log(`counting inbound datagrams for ${values.window}s...`);
  await Bun.sleep(Number(values.window) * 1000);
  const delta = ((await inboundPackets()) ?? 0) - before;
  console.log(`inbound packets over ${values.window}s: ${delta}`);
  return delta === 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const command = positionals[0];
  if (command === "preflight") {
    return await runPreflight();
  }
  if (command === "verify") {
    return await runVerify();
  }
  if (command === "run") {
    await run();
    return 0;
  }
  console.log(USAGE);
  return command === undefined ? 0 : 1;
}

process.exit(await main());
