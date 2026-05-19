import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** @type {Map<string, string> | null} */
let cachedMap = null;

/**
 * Load drive letter → volume label map (Windows). Other platforms use path heuristics only.
 * @returns {Promise<Map<string, string>>}
 */
export async function getDriveNameMap() {
  if (cachedMap) return cachedMap;
  cachedMap = new Map();
  if (process.platform === "win32") {
    await loadWindowsVolumeLabels(cachedMap);
  }
  return cachedMap;
}

/**
 * @param {Map<string, string>} map
 */
async function loadWindowsVolumeLabels(map) {
  try {
    const { stdout } = await execFileAsync("wmic", [
      "logicaldisk",
      "get",
      "DeviceID,VolumeName",
      "/format:csv",
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Node")) continue;
      const parts = trimmed.split(",");
      if (parts.length < 3) continue;
      const device = parts[1]?.trim();
      const label = parts[2]?.trim();
      if (/^[A-Z]:$/i.test(device) && label) {
        map.set(device.toUpperCase(), label);
      }
    }
  } catch {
    /* wmic unavailable — drive letter only */
  }
}

/**
 * Human-readable drive / volume name for an absolute file path.
 * @param {string} absPath
 * @param {Map<string, string>} [volumeMap] from {@link getDriveNameMap}
 * @returns {string}
 */
export function getDriveNameForPath(absPath, volumeMap) {
  const resolved = path.resolve(absPath);

  if (process.platform === "win32") {
    const m = /^([a-zA-Z]):/.exec(resolved);
    if (!m) return "Unknown";
    const letter = `${m[1].toUpperCase()}:`;
    const label = volumeMap?.get(letter);
    return label ? `${letter} (${label})` : letter;
  }

  if (process.platform === "darwin") {
    const parts = resolved.split("/").filter(Boolean);
    if (parts[0] === "Volumes" && parts[1]) return parts[1];
    if (parts[0] === "Users") return "Users";
    return "Macintosh HD";
  }

  const parts = resolved.split("/").filter(Boolean);
  if (parts[0] === "mnt" && parts[1]) return parts[1];
  if (parts[0] === "media" && parts[1]) {
    return parts[2] ? `${parts[1]}/${parts[2]}` : parts[1];
  }
  if (parts[0] === "home" && parts[1]) return `home (${parts[1]})`;
  return "/";
}
