import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { $ } from "bun";

const sudo = process.env.SUDO ?? "sudo";

const PORT_RANGE = "65400:65500";

const FREE_GB_FLOOR = 50;
const RAM_GB_FLOOR = 8;

export interface Check {
  ok: boolean;
  message: string;
  detail?: string;
}

async function iptables(...args: string[]): Promise<string> {
  return await $`${{ raw: sudo }} iptables ${args}`.text();
}

/**
 * Packets admitted by the rule covering the Turbine range, or undefined when no
 * such rule exists. A running node with an empty shred store looks identical to
 * a healthy one, so this counter is the only direct evidence anything arrives.
 */
export async function inboundPackets(): Promise<number | undefined> {
  const table = await iptables("-L", "INPUT", "-v", "-n", "-x").catch(() => "");
  const row = table.split("\n").find((line) => line.includes(PORT_RANGE));
  const packets = row?.trim().split(/\s+/)[0];
  if (packets === undefined) {
    return undefined;
  }
  return Number(packets);
}

/**
 * Opens the firewall: accepts inbound UDP on the Turbine range. This mutates the
 * host's iptables rules and is the only thing in this tool that does. Not
 * persistent across reboot.
 */
export async function openFirewall(): Promise<string> {
  const rule = ["INPUT", "-p", "udp", "--dport", PORT_RANGE, "-j", "ACCEPT"];
  const present = await $`${{ raw: sudo }} iptables -C ${rule}`
    .quiet()
    .then(() => true)
    .catch(() => false);
  if (present) {
    return `rule already present for udp ${PORT_RANGE}`;
  }
  await iptables("-A", ...rule);
  return `accepted udp ${PORT_RANGE} (not persistent across reboot)`;
}

async function checkPublicIp(): Promise<Check> {
  const publicIp = await $`curl -sS --max-time 10 https://ifconfig.me/ip`
    .text()
    .then((body) => body.trim())
    .catch(() => "");
  if (publicIp === "") {
    return { ok: false, message: "could not determine the public IP" };
  }

  const local = await $`ip -4 addr show`.text();
  if (local.includes(publicIp)) {
    return { ok: true, message: `public IP ${publicIp} is on a local interface` };
  }

  return {
    ok: false,
    message: `public IP ${publicIp} is NOT on any local interface — behind NAT`,
    detail: `Turbine is unsolicited inbound UDP; the gateway must forward ${PORT_RANGE}`,
  };
}

async function checkPortsFree(): Promise<Check> {
  const busy = (await $`ss -uln`.text())
    .split("\n")
    .slice(1)
    .flatMap(
      (line) =>
        line
          .trim()
          .split(/\s+/)[4]
          ?.match(/:(\d+)$/)?.[1] ?? [],
    )
    .map(Number)
    .filter((port) => port >= 65400 && port <= 65500);
  if (busy.length > 0) {
    return {
      ok: false,
      message: `ports in use inside ${PORT_RANGE}: ${busy.join(", ")}`,
    };
  }
  return { ok: true, message: `UDP ${PORT_RANGE} is free` };
}

async function checkInputPolicy(): Promise<Check> {
  const rules = await iptables("-S", "INPUT").catch(() => "");
  if (!rules.includes("-P INPUT DROP")) {
    return { ok: true, message: "no blanket INPUT DROP policy" };
  }
  if (rules.includes(PORT_RANGE)) {
    return {
      ok: true,
      message: "INPUT policy is DROP and the Turbine range is accepted",
    };
  }
  return {
    ok: false,
    message: "INPUT drops the Turbine range",
    detail: "run: lightstream preflight --fix",
  };
}

async function checkFreeSpace(storage: string): Promise<Check> {
  let path = storage;
  while (!existsSync(path) && path !== dirname(path)) {
    path = dirname(path);
  }

  const avail = await $`df -BG --output=avail ${path}`.text().catch(() => "");
  const freeGb = Number(avail.split("\n")[1]?.replace(/\D/g, "") ?? 0);
  if (freeGb < FREE_GB_FLOOR) {
    return { ok: false, message: `only ${freeGb}G free at ${path}` };
  }
  return { ok: true, message: `${freeGb}G free at ${path}` };
}

function checkRam(): Check {
  const meminfo = readFileSync("/proc/meminfo", "utf8");
  const kb = Number(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0);
  const ramGb = Math.floor(kb / 1024 / 1024);
  if (ramGb < RAM_GB_FLOOR) {
    return {
      ok: false,
      message: `${ramGb}G RAM is below the ${RAM_GB_FLOOR}G floor for mainnet-rate reassembly`,
    };
  }
  return { ok: true, message: `${ramGb}G RAM` };
}

/**
 * Whether this host can receive Turbine at all, which is the question that kills
 * most attempts. Reports every check rather than stopping at the first failure.
 */
export async function preflight(storage: string): Promise<Check[]> {
  return [
    await checkPublicIp(),
    await checkPortsFree(),
    await checkInputPolicy(),
    await checkFreeSpace(storage),
    checkRam(),
  ];
}
