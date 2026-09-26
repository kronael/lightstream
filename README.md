# lightstream

Spawns a [Lightbringer](https://github.com/Overclock-Validator/lightbringer) node,
listens to its block stream, and indexes only the transactions from blocks
something vouched for — with the sign-off read from the node's own configuration
rather than asserted by a flag or a vendor.

## Why

Every ordinary Solana feed hands you a commitment level you cannot check: a
provider's `confirmed`, a vendor's `finalized`. Lightbringer reassembles blocks
from Turbine itself and verifies their BLS finalization certificates locally
against the epoch's rank map. It had no consumer other than a full verifying
node. This is that consumer.

## Use

```sh
make proto-sync LIGHTBRINGER=/path/to/lightbringer   # see NOTICE
bun install

bun run lightstream preflight --fix     # can this host receive Turbine?
bun run lightstream run \
  --binary /usr/local/bin/lightbringer \
  --snapshot https://api.mainnet-beta.solana.com
```

`run` writes the node's config, spawns it, waits for its gRPC socket, and indexes
into SQLite until interrupted — then stops the node with it. Drop `--binary` to
attach to a node someone else runs, with `--config` pointing at its
`Lightbringer.toml`.

`lightstream verify` counts the datagrams the firewall admitted, which is the only
direct proof that Turbine traffic actually reaches the host.

## The sign-off

Lightbringer's stream carries `slot`, `parent_slot` and entries — no finality
marker. What a delivered slot *means* is decided by the node's configuration, so
that is where `src/signoff.ts` reads it:

| Node config | Sign-off | What arrives |
|---|---|---|
| `mode = "alpenglow"` (`--snapshot`) | `alpenglow-cert` | only slots whose finalization certificate verified |
| `mode = "rpc"` | `rpc-confirmed` | only slots an RPC WebSocket confirmed |
| no `[block_confirmation]` | `none` | every reassembled slot, forks and losers included |

`run` exits on `none` unless you pass `--allow-processed`, and stamps the sign-off
on every row, so one database never silently mixes verified and unverified history.

## The snapshot source

`--snapshot` is where Lightbringer fetches the snapshot manifest holding the epoch
stake table, which is what its certificate arithmetic is checked against. It must
be a node that serves snapshots: the fetch tries `snapshot.tar.zst`,
`snapshot.tar.bz2` and the `incremental-` pair under that base, and requires the
redirect to land on a `.tar.zst` artifact. A plain JSON-RPC endpoint will not do.
Point it at the cluster you are following — a mainnet index needs a mainnet
snapshot.

## Requirements

- **A host that can receive Turbine.** It is unsolicited inbound UDP; a NAT'd or
  firewalled machine receives nothing while looking healthy. `preflight` checks
  this in ten seconds.
- **The Lightbringer binary**, built from its own repository.
- **Bun**, pinned in `.bun-version`.
- Trust: the certificate arithmetic and the stake table in the snapshot manifest.
  Not any RPC provider — though Lightbringer itself still fetches the leader
  schedule over JSON-RPC.

## Distribution

`make compile` produces `dist/lightstream`, a single executable for a host with no
bun and no source tree; it needs `LIGHTSTREAM_PROTO_DIR` pointing at a directory
holding `pb/*.proto`. `deploy/lightstream.service` runs it under systemd,
supervising Lightbringer as its child.

## Limits

- Never run against live mainnet data: every host available during development was
  behind NAT. Connect, decode and shutdown paths are verified; throughput is
  unmeasured.
- Transaction payloads are not stored, only signature and account keys.
- With `signoff = 'none'` the losing side of a fork is indexed and nothing ever
  retracts it.
- The stream has no replay on reconnect; `run` reports parent-link breaks but does
  not backfill them.

## Credit

The ingest, the repair, and the certificate verification are all Lightbringer's, by
Overclock Validator, built on Agave's gossip and shred crates. This package is the
consumer and the operator's diagnostics around it. Proto provenance and a licensing
caveat: NOTICE.

Copyright (C) 2026 lightstream contributors. GPL-3.0-only, see LICENSE. This
program comes with ABSOLUTELY NO WARRANTY.
