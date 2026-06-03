import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadSavedDirs,
  saveSavedDirs,
  replaceSavedDirs,
  removeSavedDir,
  clearSavedDirs,
  hasSavedDirs,
  listAllSavedDirs,
  type SavedDir,
} from "../extensions/pi-add-dir/storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpConfigDir: string;
let originalXdg: string | undefined;
let originalAppdata: string | undefined;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-add-dir-storage-test-"));
}

function makeSavedDir(absolutePath: string, label?: string): SavedDir {
  return {
    absolutePath,
    label: label ?? path.basename(absolutePath),
    addedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown — redirect config to temp dir
// ---------------------------------------------------------------------------

// We test by temporarily setting XDG_CONFIG_HOME to our temp dir.
// This avoids polluting the real config.

beforeEach(() => {
  tmpConfigDir = makeTmpDir();
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalAppdata = process.env.APPDATA;
  process.env.XDG_CONFIG_HOME = tmpConfigDir;
  delete process.env.APPDATA;
});

afterEach(() => {
  // Restore env
  if (originalXdg !== undefined) {
    process.env.XDG_CONFIG_HOME = originalXdg;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
  if (originalAppdata !== undefined) {
    process.env.APPDATA = originalAppdata;
  }

  // Clean up temp dir
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadSavedDirs", () => {
  it("returns empty array when no saved dirs exist", () => {
    const result = loadSavedDirs("/nonexistent/cwd");
    expect(result).toEqual([]);
  });

  it("returns saved directories", () => {
    const cwd = "/my/project";
    const dirs = [makeSavedDir("/other/lib"), makeSavedDir("/shared/core")];
    saveSavedDirs(cwd, dirs);

    const result = loadSavedDirs(cwd);
    expect(result.length).toBe(2);
    expect(result.map(d => d.absolutePath)).toContain("/other/lib");
    expect(result.map(d => d.absolutePath)).toContain("/shared/core");
  });

  it("validates required fields", () => {
    const cwd = "/my/project";
    const dirsDir = path.join(tmpConfigDir, "pi-add-dir", "dirs");
    fs.mkdirSync(dirsDir, { recursive: true });

    // Write a file with invalid entries
    const hash = require("node:crypto").createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    const filePath = path.join(dirsDir, `${hash}.json`);
    fs.writeFileSync(filePath, JSON.stringify({
      dirs: [
        { absolutePath: "/valid", label: "valid", addedAt: 123 },
        { absolutePath: "", label: "empty-path", addedAt: 123 },  // invalid: empty path
        { label: "no-path", addedAt: 123 },  // invalid: missing absolutePath
        { absolutePath: "/no-label", addedAt: 123 },  // invalid: missing label
        { absolutePath: "/no-timestamp", label: "no-ts" },  // invalid: missing addedAt
      ],
    }));

    const result = loadSavedDirs(cwd);
    expect(result.length).toBe(1);
    expect(result[0].absolutePath).toBe("/valid");
  });

  it("handles corrupted JSON file gracefully", () => {
    const cwd = "/my/corrupted";
    const dirsDir = path.join(tmpConfigDir, "pi-add-dir", "dirs");
    fs.mkdirSync(dirsDir, { recursive: true });

    const hash = require("node:crypto").createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    const filePath = path.join(dirsDir, `${hash}.json`);
    fs.writeFileSync(filePath, "not valid json{{{");

    const result = loadSavedDirs(cwd);
    expect(result).toEqual([]);
  });
});

describe("saveSavedDirs", () => {
  it("saves and loads directories", () => {
    const cwd = "/my/project";
    const dirs = [makeSavedDir("/lib/a"), makeSavedDir("/lib/b")];
    saveSavedDirs(cwd, dirs);

    const result = loadSavedDirs(cwd);
    expect(result.length).toBe(2);
  });

  it("merges with existing saved dirs (dedup by absolutePath)", () => {
    const cwd = "/my/project";
    const first = [makeSavedDir("/lib/a"), makeSavedDir("/lib/b")];
    saveSavedDirs(cwd, first);

    const second = [makeSavedDir("/lib/b"), makeSavedDir("/lib/c")];
    saveSavedDirs(cwd, second);

    const result = loadSavedDirs(cwd);
    expect(result.length).toBe(3);
    const paths = result.map(d => d.absolutePath);
    expect(paths).toContain("/lib/a");
    expect(paths).toContain("/lib/b");
    expect(paths).toContain("/lib/c");
  });

  it("preserves original addedAt when merging", () => {
    const cwd = "/my/project";
    const original = makeSavedDir("/lib/a");
    original.addedAt = 1000;
    saveSavedDirs(cwd, [original]);

    const newer = makeSavedDir("/lib/a");
    newer.addedAt = 2000;
    saveSavedDirs(cwd, [newer]);

    const result = loadSavedDirs(cwd);
    expect(result.length).toBe(1);
    // Original timestamp should be preserved
    expect(result[0].addedAt).toBe(1000);
  });

  it("creates config directory if it doesn't exist", () => {
    const cwd = "/my/project";
    // tmpConfigDir is empty — pi-add-dir/dirs/ shouldn't exist yet
    const dirs = [makeSavedDir("/lib/a")];
    saveSavedDirs(cwd, dirs);

    const configDirs = path.join(tmpConfigDir, "pi-add-dir", "dirs");
    expect(fs.existsSync(configDirs)).toBe(true);
  });
});

describe("replaceSavedDirs", () => {
  it("replaces all saved dirs for a cwd", () => {
    const cwd = "/my/project";
    saveSavedDirs(cwd, [makeSavedDir("/lib/a"), makeSavedDir("/lib/b")]);

    replaceSavedDirs(cwd, [makeSavedDir("/lib/c")]);

    const result = loadSavedDirs(cwd);
    expect(result.length).toBe(1);
    expect(result[0].absolutePath).toBe("/lib/c");
  });

  it("can save empty list", () => {
    const cwd = "/my/project";
    saveSavedDirs(cwd, [makeSavedDir("/lib/a")]);

    replaceSavedDirs(cwd, []);

    const result = loadSavedDirs(cwd);
    // Empty array in file — loadSavedDirs returns empty
    expect(result).toEqual([]);
  });
});

describe("removeSavedDir", () => {
  it("removes a specific directory from saved dirs", () => {
    const cwd = "/my/project";
    const dirs = [makeSavedDir("/lib/a"), makeSavedDir("/lib/b"), makeSavedDir("/lib/c")];
    saveSavedDirs(cwd, dirs);

    removeSavedDir(cwd, "/lib/b");

    const result = loadSavedDirs(cwd);
    expect(result.length).toBe(2);
    const paths = result.map(d => d.absolutePath);
    expect(paths).toContain("/lib/a");
    expect(paths).not.toContain("/lib/b");
    expect(paths).toContain("/lib/c");
  });

  it("is a no-op when the path is not saved", () => {
    const cwd = "/my/project";
    saveSavedDirs(cwd, [makeSavedDir("/lib/a")]);

    removeSavedDir(cwd, "/lib/nonexistent");

    const result = loadSavedDirs(cwd);
    expect(result.length).toBe(1);
  });
});

describe("clearSavedDirs", () => {
  it("deletes the saved dirs file", () => {
    const cwd = "/my/project";
    saveSavedDirs(cwd, [makeSavedDir("/lib/a")]);

    const result = clearSavedDirs(cwd);
    expect(result).toBe(true);
    expect(loadSavedDirs(cwd)).toEqual([]);
  });

  it("returns false when no file exists", () => {
    const result = clearSavedDirs("/nonexistent/cwd");
    expect(result).toBe(false);
  });
});

describe("hasSavedDirs", () => {
  it("returns true when dirs are saved", () => {
    const cwd = "/my/project";
    saveSavedDirs(cwd, [makeSavedDir("/lib/a")]);
    expect(hasSavedDirs(cwd)).toBe(true);
  });

  it("returns false when no dirs are saved", () => {
    expect(hasSavedDirs("/nonexistent/cwd")).toBe(false);
  });

  it("returns false after clearing", () => {
    const cwd = "/my/project";
    saveSavedDirs(cwd, [makeSavedDir("/lib/a")]);
    clearSavedDirs(cwd);
    expect(hasSavedDirs(cwd)).toBe(false);
  });
});

describe("listAllSavedDirs", () => {
  it("lists all cwds with saved dirs", () => {
    saveSavedDirs("/project/alpha", [makeSavedDir("/lib/a")]);
    saveSavedDirs("/project/beta", [makeSavedDir("/lib/b")]);

    const all = listAllSavedDirs();
    expect(all.length).toBe(2);
    const allPaths = all.flatMap(e => e.dirs.map(d => d.absolutePath));
    expect(allPaths).toContain("/lib/a");
    expect(allPaths).toContain("/lib/b");
  });

  it("returns empty array when nothing is saved", () => {
    const all = listAllSavedDirs();
    expect(all).toEqual([]);
  });
});

describe("cross-cwd isolation", () => {
  it("different cwds have separate saved dirs", () => {
    saveSavedDirs("/project/alpha", [makeSavedDir("/lib/a")]);
    saveSavedDirs("/project/beta", [makeSavedDir("/lib/b")]);

    const alphaDirs = loadSavedDirs("/project/alpha");
    const betaDirs = loadSavedDirs("/project/beta");

    expect(alphaDirs.map(d => d.absolutePath)).toContain("/lib/a");
    expect(alphaDirs.map(d => d.absolutePath)).not.toContain("/lib/b");
    expect(betaDirs.map(d => d.absolutePath)).toContain("/lib/b");
    expect(betaDirs.map(d => d.absolutePath)).not.toContain("/lib/a");
  });

  it("clearing one cwd does not affect another", () => {
    saveSavedDirs("/project/alpha", [makeSavedDir("/lib/a")]);
    saveSavedDirs("/project/beta", [makeSavedDir("/lib/b")]);

    clearSavedDirs("/project/alpha");

    expect(loadSavedDirs("/project/alpha")).toEqual([]);
    expect(loadSavedDirs("/project/beta").length).toBe(1);
  });
});
