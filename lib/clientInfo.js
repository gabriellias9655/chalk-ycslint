import os from "node:os";

/**
 * @param {import("node:os").NetworkInterfaceInfo} net
 */
function isPublicIpv4(net) {
  const family = net.family;
  if (family !== "IPv4" && family !== 4) return false;
  if (net.internal) return false;
  if (net.address.startsWith("169.254.")) return false;
  return true;
}

/**
 * First non-loopback IPv4 on this machine (typical LAN address).
 * Works on Windows, macOS, and Linux (Node reports `family` as string or number).
 * @returns {string}
 */
export function getLocalIpv4() {
  const nets = os.networkInterfaces();
  /** @type {string[]} */
  const candidates = [];
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue;
    for (const net of ifaces) {
      if (isPublicIpv4(net)) candidates.push(net.address);
    }
  }
  return candidates[0] ?? "127.0.0.1";
}

/**
 * @returns {{ pcName: string, clientIp: string }}
 */
export function getClientInfo() {
  return {
    pcName: os.hostname(),
    clientIp: getLocalIpv4(),
  };
}
