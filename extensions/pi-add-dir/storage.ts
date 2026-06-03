/**
 * Persistent directory storage for pi-add-dir.
 *
 * Saves added directories per working directory so they auto-load
 * when a new pi session starts in the same cwd.
 *
 * Storage location:
 *   - $XDG_CONFIG_HOME/pi-add-dir/dirs/<cwdHash>.json  (Unix with XDG)
 *   - $APPDATA/pi-add-dir/dirs/<cwdHash>.json           (Windows)
 *   - ~/.config/pi-add-dir/dirs/<cwdHash>.json           (fallback)
 *
 * File format:
 *   { "dirs": [{ "absolutePath": "...", "label": "...", "addedAt": 1234 }] }
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SavedDir {
  /** Absolute path to the directory */
  absolutePath: string;
  /** Display label */
  label: string;
  /** Timestamp when first added */
  addedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIRS_SUBDIR = "dirs";
const APP_NAME = "pi-add-dir";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic safe filename from a cwd path.
 */
function cwdHash(cwd: string): string {
  return crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/**
 * Get the base config directory for pi-add-dir persistent storage.
 *
 * Priority:
 * 1. XDG_CONFIG_HOME (Unix with XDG)
 * 2. APPDATA (Windows)
 * 3. ~/.config (fallback)
 */
function getConfigBase(): string {
  // XDG_CONFIG_HOME (Unix)
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, APP_NAME);

  // APPDATA (Windows)
  const appdata = process.env.APPDATA;
  if (appdata) return path.join(appdata, APP_NAME);

  // Fallback: ~/.config
  return path.join(os.homedir(), ".config", APP_NAME);
}

/**
 * Get the directory where saved dir files are stored.
 */
function getDirsDir(): string {
  return path.join(getConfigBase(), DIRS_SUBDIR);
}

/**
 * Get the file path for a specific cwd's saved dirs.
 */
function getSavedDirsPath(cwd: string): string {
  return path.join(getDirsDir(), `${cwdHash(cwd)}.json`);
}

/**
 * Ensure the dirs directory exists.
 */
function ensureDirsDir(): void {
  const dir = getDirsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load saved directories for a given cwd.
 * Returns an empty array if no saved state exists.
 */
export function loadSavedDirs(cwd: string): SavedDir[] {
  const filePath = getSavedDirsPath(cwd);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content) as { dirs?: SavedDir[] };
    if (!Array.isArray(data.dirs)) return [];
    // Validate each entry has required fields
    return data.dirs.filter(
      (d): d is SavedDir =>
        typeof d.absolutePath === "string" &&
        typeof d.label === "string" &&
        typeof d.addedAt === "number" &&
        d.absolutePath.length > 0,
    );
  } catch {
    return [];
  }
}

/**
 * Save directories for a given cwd.
 * Merges with existing saved dirs (dedup by absolutePath).
 */
export function saveSavedDirs(cwd: string, dirs: SavedDir[]): void {
  ensureDirsDir();
  const filePath = getSavedDirsPath(cwd);

  // Load existing and merge
  const existing = loadSavedDirs(cwd);
  const merged = new Map<string, SavedDir>();

  // Existing entries first (preserve their timestamps)
  for (const d of existing) {
    merged.set(d.absolutePath, d);
  }

  // New/updated entries
  for (const d of dirs) {
    const key = d.absolutePath;
    if (!merged.has(key)) {
      merged.set(key, d);
    }
    // If already saved, keep existing (preserve original addedAt)
  }

  const data = { dirs: [...merged.values()] };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Replace saved directories for a given cwd entirely.
 * Use this when dirs are removed and you need the saved state to reflect that.
 */
export function replaceSavedDirs(cwd: string, dirs: SavedDir[]): void {
  ensureDirsDir();
  const filePath = getSavedDirsPath(cwd);
  const data = { dirs };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Remove a specific directory from saved dirs for a cwd.
 */
export function removeSavedDir(cwd: string, absolutePath: string): void {
  const current = loadSavedDirs(cwd);
  const filtered = current.filter(d => d.absolutePath !== absolutePath);
  replaceSavedDirs(cwd, filtered);
}

/**
 * Clear all saved directories for a given cwd.
 * Returns true if a file was deleted, false if none existed.
 */
export function clearSavedDirs(cwd: string): boolean {
  const filePath = getSavedDirsPath(cwd);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all cwds that have saved directories.
 * Returns array of { cwd, dirs } objects.
 */
export function listAllSavedDirs(): { cwdHash: string; path: string; dirs: SavedDir[] }[] {
  const dirsDir = getDirsDir();
  try {
    const files = fs.readdirSync(dirsDir).filter(f => f.endsWith(".json"));
    return files.map(f => {
      const filePath = path.join(dirsDir, f);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(content) as { dirs?: SavedDir[] };
        return {
          cwdHash: f.replace(".json", ""),
          path: filePath,
          dirs: Array.isArray(data.dirs) ? data.dirs : [],
        };
      } catch {
        return { cwdHash: f.replace(".json", ""), path: filePath, dirs: [] };
      }
    });
  } catch {
    return [];
  }
}

/**
 * Check if there are saved dirs for a given cwd.
 */
export function hasSavedDirs(cwd: string): boolean {
  const filePath = getSavedDirsPath(cwd);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content) as { dirs?: SavedDir[] };
    return Array.isArray(data.dirs) && data.dirs.length > 0;
  } catch {
    return false;
  }
}
