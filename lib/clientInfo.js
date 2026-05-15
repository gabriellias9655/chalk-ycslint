import os from "node:os";

/**
 * @param {import("node:os").NetworkInterfaceInfo} net
 */
function isPublicIpv4(net) {
  const family = net.family;
  if (family !== "IPv4" && family !== 4) return false;
  return !net.internal;
}

/**
 * First non-loopback IPv4 on this machine (typical LAN address).
 * @returns {string}
 */
export function getLocalIpv4() {
  const nets = os.networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue;
    for (const net of ifaces) {
      if (isPublicIpv4(net)) return net.address;
    }
  }
  return "127.0.0.1";
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
