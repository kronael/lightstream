# lightstream

Spawns a [Lightbringer](https://github.com/Overclock-Validator/lightbringer) node,
listens to its block stream, and indexes only the transactions from blocks
something vouched for — with the sign-off read from the node's own configuration
rather than asserted by a flag or a vendor.

## Why

Every ordinary Solana feed hands you a commitment level you cannot check: a
provider's `confirmed`, a vendor's `finalized`. You are trusting their word.
Lightbringer rebuilds blocks from the network itself and checks the validators'
signatures on them locally, on your machine. It had no consumer other than a full
verifying node — it ships only `lightbringer-grpc-client`, which logs slot and
transaction counts. This is a real consumer.

## Words you need

Solana pushes new blocks to the network in pieces rather than sending whole blocks
to everyone.

- **Shred** — one of those pieces. A block arrives as hundreds of them.
- **Turbine** — the mechanism that pushes shreds out, each node forwarding to the
  next. Nobody asks for them, so a node just receives them: that is why receiving
  Turbine is *unsolicited inbound UDP*, and why a machine behind NAT gets nothing.
- **Gossip** — how nodes find each other. A node joins by talking to an
  *entrypoint*, a known address that introduces it to the rest.
- **Finalization certificate** — the proof a block was agreed on: a bundle of
  validator signatures. Checking one means checking the signatures add up to
  enough of the network's stake. These certificates come from **Alpenglow**, Solana's
  consensus protocol, which is what `mode = "alpenglow"` below means.
- **Rank map** — who holds how much stake this epoch. You need it to know whether
  the signatures on a certificate add up to enough. It comes out of a **snapshot**,
  a dump of chain state that a node serves over HTTP.

So: Lightbringer collects shreds off Turbine, rebuilds blocks, and checks each
block's certificate against the rank map. lightstream reads what it produces.

## Requirements

- **A host that can receive Turbine.** A NAT'd or firewalled machine receives
  nothing while looking perfectly healthy. `preflight` checks this in ten seconds
  and is the first thing to run.
- **The Lightbringer binary and a checkout of its repository**, built from source.
  You need the checkout as well as the binary: the build copies two `.proto` files
  out of it (see NOTICE for why they are not shipped here).
- **Bun**, pinned in `.bun-version`.
- Trust, stated plainly: the certificate arithmetic, **and two HTTP endpoints you
  must not assume are honest**. The stake table arrives as a snapshot manifest
  fetched over plain HTTP with no hash check, from `--snapshot`. The leader schedule
  every shred is checked against comes from `--rpc`. Either one lying fails closed;
  both lying together can make injected shreds look final. What you avoid is
  trusting a provider's *commitment label* — not trusting providers.

## Use

```sh
make proto-sync LIGHTBRINGER=/path/to/lightbringer   # needs that checkout
bun install

bun run lightstream preflight           # read-only: can this host receive Turbine?
bun run lightstream run \
  --binary /usr/local/bin/lightbringer \
  --snapshot https://api.mainnet-beta.solana.com \
  --rpc https://api.mainnet-beta.solana.com
```

`preflight` reports all five checks and exits non-zero if any failed; that exit is
the verdict, not a crash. **`preflight --fix` is not read-only** — it adds an
iptables rule accepting inbound UDP on the Turbine range. It is the only thing in
this tool that changes your machine.

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
`--allow-processed` is not a convenience flag: on `none` the losing side of every
fork is indexed and nothing ever retracts it.

## The snapshot source

`--snapshot` is where Lightbringer fetches the snapshot manifest holding the epoch
stake table, which is what its certificate arithmetic is checked against. It must
be a node that serves snapshots: the fetch tries `incremental-snapshot.tar.zst`,
`incremental-snapshot.tar.bz2`, `snapshot.tar.zst` and `snapshot.tar.bz2` under that
base in that order, and requires the redirect to land on a `.tar.zst` artifact. A
plain JSON-RPC endpoint will not do.

`--rpc` must name the **same cluster**. Lightbringer defaults it to its own Alpenglow
test cluster, whose leader schedule matches no mainnet shred — every shred would be
dropped before reassembly and the stream would stay empty with no error at all. `run`
refuses `--snapshot` without `--rpc` for exactly that reason.

## Running it as a service

`make install` puts `dist/lightstream` at `$PREFIX/bin` and the protos at
`$PREFIX/share/lightstream/proto`, which is the layout the units expect
(`PREFIX ?= /usr/local`, `DESTDIR` honoured). Create the `lightstream` user and
`/var/lib/lightstream` yourself, then enable **one** of the two units:
`lightstream.service` spawns Lightbringer itself, `lightbringer.service` runs it
standalone for the attach case. Enabling both runs two nodes contending for UDP
65400-65500 and the gRPC port.

Run `lightstream preflight` before enabling and after any network change. It is
deliberately not an `ExecStartPre`: its disk and RAM floors are conservative
estimates, not measurements, and should not silently block a start.

What to watch, none of which the tool exposes for you yet: the `breaks` counter in
the run log (parent-link discontinuities — a restart produces a gap that is never
backfilled), the growth of the SQLite file (it only ever grows; `make clean`
deletes it and there is no rotation or archival), and free space against the same
floor `preflight` checks once at start. Lightbringer's own unit appends to
`/var/log/lightbringer/lightbringer.log` with no rotation configured.

## Limits

- Never run against live mainnet data: every host available during development was
  behind NAT. The connect and shutdown paths are verified; the decode path has never
  seen a real slot, throughput is unmeasured, and the `preflight` floors (50G disk,
  8G RAM) are estimates that no measurement backs.
- Only `src/base58.ts` and `src/signoff.ts` have tests. The host checks, the node
  spawn, the stream decode and the CLI run loop do not.
- There is no CI. `make lint` and `make test` are the gate, run by hand.
- Transaction payloads are not stored, only signature and account keys.
- `--accounts` matches only the account keys carried in the message. A v0
  transaction that reaches an account through an address lookup table will not match,
  which covers most DeFi traffic. `slots.tx_count` is the filtered count, not the
  block's.
- With `signoff = 'none'` the losing side of a fork is indexed and nothing ever
  retracts it.
- lightstream never backfills. Lightbringer does expose `CatchupSlots`, but it
  serves stored shreds with no confirmation gating, so using it naively would
  reintroduce unvouched blocks under whatever sign-off the run carries. `run` reports
  parent-link breaks and stops there.
- A slow consumer loses slots silently: the node's broadcast channel drops on lag and
  the only symptom is the break counter, which under `none` cannot tell loss from a
  fork.

## Credit

The ingest, the repair, and the certificate verification are all Lightbringer's, by
Overclock Validator, built on Agave's gossip and shred crates. This package is the
consumer and the operator's diagnostics around it. Proto provenance and a licensing
caveat: NOTICE.

Copyright (C) 2026 lightstream contributors. GPL-3.0-only, see LICENSE. This
program comes with ABSOLUTELY NO WARRANTY.
