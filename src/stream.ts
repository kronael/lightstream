import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChannelCredentials,
  type ClientReadableStream,
  credentials,
  loadPackageDefinition,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { base58 } from "./base58.ts";

const COMPILED_BINARY_VFS = "/$bunfs";
const moduleProtos = join(dirname(fileURLToPath(import.meta.url)), "..", "proto");
const PROTO_DIR =
  process.env.LIGHTSTREAM_PROTO_DIR ??
  (moduleProtos.startsWith(COMPILED_BINARY_VFS)
    ? join(process.cwd(), "proto")
    : moduleProtos);

export interface Tx {
  signature: string;
  accountKeys: string[];
}

export interface Slot {
  slot: number;
  parentSlot: number;
  txs: Tx[];
}

interface RawMessage {
  accountKeys: Uint8Array[];
}

interface RawTx {
  signatures: Uint8Array[];
  message: "messageLegacy" | "messageV0" | "messageV1";
  messageLegacy?: RawMessage;
  messageV0?: RawMessage;
  messageV1?: RawMessage;
}

interface RawEntry {
  transactions: RawTx[];
}

interface RawSlot {
  slot: number;
  parentSlot: number;
  entries: RawEntry[];
}

interface SlotStreamClient {
  StreamSlots(req: Record<string, never>): ClientReadableStream<RawSlot>;
}

interface SlotStreamNamespace {
  SlotStream: new (addr: string, creds: ChannelCredentials) => SlotStreamClient;
}

interface SlotStreamPackage {
  slot_stream: SlotStreamNamespace;
}

function decodeTx(raw: RawTx): Tx | undefined {
  const signature = raw.signatures[0];
  if (signature === undefined) {
    return undefined;
  }
  const message = raw[raw.message];
  return {
    signature: base58(signature),
    accountKeys: (message?.accountKeys ?? []).map(base58),
  };
}

function decodeSlot(raw: RawSlot): Slot {
  const txs: Tx[] = [];
  for (const entry of raw.entries) {
    for (const rawTx of entry.transactions) {
      const tx = decodeTx(rawTx);
      if (tx !== undefined) {
        txs.push(tx);
      }
    }
  }
  return { slot: raw.slot, parentSlot: raw.parentSlot, txs };
}

function slotStreamClient(endpoint: string): SlotStreamClient {
  if (!existsSync(join(PROTO_DIR, "pb", "slot_stream.proto"))) {
    throw new Error(
      `no protos at ${PROTO_DIR}/pb — copy slot_stream.proto and slot_entry.proto ` +
        `from a Lightbringer checkout there, or set LIGHTSTREAM_PROTO_DIR`,
    );
  }
  const definition = loadSync("pb/slot_stream.proto", {
    includeDirs: [PROTO_DIR],
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = loadPackageDefinition(definition) as unknown as SlotStreamPackage;
  return new proto.slot_stream.SlotStream(endpoint, credentials.createInsecure());
}

/** An AbortSignal that fires on the first SIGINT or SIGTERM. */
export function shutdownSignal(onStop?: () => void): AbortSignal {
  const stopping = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      onStop?.();
      stopping.abort();
    });
  }
  return stopping.signal;
}

/**
 * Yields every slot Lightbringer delivers. What a delivered slot means depends on
 * the node's block-confirmation mode, not on anything in the message — see
 * readSignoff. Aborting `signal` cancels the call and ends the generator, which is
 * the only way out of a quiet stream.
 */
export async function* streamSlots(
  endpoint: string,
  signal?: AbortSignal,
): AsyncGenerator<Slot> {
  const call = slotStreamClient(endpoint).StreamSlots({});
  signal?.addEventListener("abort", () => call.cancel(), { once: true });
  try {
    for await (const raw of call) {
      yield decodeSlot(raw);
    }
  } catch (error) {
    if (signal?.aborted !== true) {
      throw error;
    }
  } finally {
    call.cancel();
  }
}
