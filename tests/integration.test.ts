/**
 * Integration test for persistent directory memory.
 *
 * Simulates the session_start / addDir / removeDir / reconstructState flow
 * that the extension actually goes through, using the real storage.ts module
 * and mocking only the pi ExtensionAPI/ExtensionContext parts.
 */
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
  _setConfigBaseOverride,
} from "../extensions/pi-add-dir/storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHomeDir: string;
let tmpProjectDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-add-dir-integ-test-"));
}

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

beforeEach(() => {
  tmpHomeDir = makeTmpDir();
  tmpProjectDir = makeTmpDir();
  _setConfigBaseOverride(path.join(tmpHomeDir, ".pi", "agent"));
});

afterEach(() => {
  _setConfigBaseOverride(undefined);
  fs.rmSync(tmpHomeDir, { recursive: true, force: true });
  fs.rmSync(tmpProjectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Simulated extension state machine
// ---------------------------------------------------------------------------

/**
 * Simulates the relevant parts of the extension's state management.
 * This lets us test the actual flow without needing a running pi instance.
 */
class SimulatedExtension {
  addedDirs: { absolutePath: string; label: string; addedAt: number }[] = [];
  currentCwd: string = "";

  /** sessionManager.getBranch() mock entries */
  sessionEntries: { type: string; customType?: string; data?: { dirs: { absolutePath: string; label: string; addedAt: number }[] } }[] = [];

  reconstructState(cwd: string) {
    this.addedDirs = [];
    this.currentCwd = cwd;

    // Auto-load saved dirs
    const savedDirs = loadSavedDirs(cwd);

    // Reconstruct from session entries
    for (const entry of this.sessionEntries) {
      if (entry.type === "custom" && entry.customType === "add-dir:state") {
        this.addedDirs = entry.data?.dirs ?? [];
      }
    }

    // Merge saved dirs
    if (savedDirs.length > 0 && this.addedDirs.length === 0) {
      const existing = savedDirs.filter(d => fs.existsSync(d.absolutePath));
      this.addedDirs = existing;
      if (existing.length > 0) {
        this.sessionEntries.push({
          type: "custom",
          customType: "add-dir:state",
          data: { dirs: existing },
        });
      }
      // Always update saved dirs to prune stale paths (even if all pruned)
      if (existing.length < savedDirs.length) {
        replaceSavedDirs(cwd, existing);
      }
    } else if (savedDirs.length > 0 && this.addedDirs.length > 0) {
      const existingPaths = new Set(this.addedDirs.map(d => d.absolutePath));
      const newDirs = savedDirs.filter(d => !existingPaths.has(d.absolutePath) && fs.existsSync(d.absolutePath));
      if (newDirs.length > 0) {
        this.addedDirs.push(...newDirs);
        this.sessionEntries.push({
          type: "custom",
          customType: "add-dir:state",
          data: { dirs: this.addedDirs },
        });
      }
    }
  }

  addDir(dirPath: string): { ok: boolean; message: string } {
    const absolutePath = path.resolve(this.currentCwd, dirPath);

    if (!fs.existsSync(absolutePath)) {
      return { ok: false, message: `Directory does not exist: ${absolutePath}` };
    }
    if (this.addedDirs.some(d => d.absolutePath === absolutePath)) {
      return { ok: false, message: `Already added: ${absolutePath}` };
    }

    const label = path.basename(absolutePath);
    const newDir = { absolutePath, label, addedAt: Date.now() };
    this.addedDirs.push(newDir);

    // Update session entries
    this.sessionEntries.push({
      type: "custom",
      customType: "add-dir:state",
      data: { dirs: [...this.addedDirs] },
    });

    // Persist to saved dirs
    saveSavedDirs(this.currentCwd, [newDir]);

    return { ok: true, message: `Added ${label}` };
  }

  removeDir(absolutePath: string): { ok: boolean; message: string } {
    const idx = this.addedDirs.findIndex(d => d.absolutePath === absolutePath);
    if (idx === -1) {
      return { ok: false, message: `Not found: ${absolutePath}` };
    }

    const removed = this.addedDirs.splice(idx, 1)[0];

    // Update session entries
    this.sessionEntries.push({
      type: "custom",
      customType: "add-dir:state",
      data: { dirs: [...this.addedDirs] },
    });

    // Remove from saved dirs
    removeSavedDir(this.currentCwd, removed.absolutePath);

    return { ok: true, message: `Removed ${removed.label}` };
  }
}

// ---------------------------------------------------------------------------
// Integration scenarios
// ---------------------------------------------------------------------------

describe("integration: new session auto-loads saved dirs", () => {
  it("auto-loads previously added dirs on new session", () => {
    // Session 1: add dirs in a cwd
    const cwd = tmpProjectDir;
    const dirA = path.join(tmpProjectDir, "dir-a");
    const dirB = path.join(tmpProjectDir, "dir-b");
    mkdirp(dirA);
    mkdirp(dirB);

    const ext1 = new SimulatedExtension();
    ext1.reconstructState(cwd);
    expect(ext1.addedDirs.length).toBe(0);

    ext1.addDir(dirA);
    ext1.addDir(dirB);
    expect(ext1.addedDirs.length).toBe(2);

    // Simulate new session (empty session entries)
    const ext2 = new SimulatedExtension();
    ext2.reconstructState(cwd);

    // Should auto-load from saved dirs
    expect(ext2.addedDirs.length).toBe(2);
    const paths = ext2.addedDirs.map(d => d.absolutePath);
    expect(paths).toContain(dirA);
    expect(paths).toContain(dirB);
  });

  it("prunes deleted dirs from saved state on auto-load", () => {
    const cwd = tmpProjectDir;
    const dirA = path.join(tmpProjectDir, "dir-a");
    const dirB = path.join(tmpProjectDir, "dir-b");
    mkdirp(dirA);
    mkdirp(dirB);

    // Session 1: add both dirs
    const ext1 = new SimulatedExtension();
    ext1.reconstructState(cwd);
    ext1.addDir(dirA);
    ext1.addDir(dirB);

    // Delete dirB from disk
    fs.rmSync(dirB, { recursive: true, force: true });

    // Session 2: auto-load should prune dirB
    const ext2 = new SimulatedExtension();
    ext2.reconstructState(cwd);

    expect(ext2.addedDirs.length).toBe(1);
    expect(ext2.addedDirs[0].absolutePath).toBe(dirA);

    // Saved dirs file should also be updated
    const saved = loadSavedDirs(cwd);
    expect(saved.length).toBe(1);
    expect(saved[0].absolutePath).toBe(dirA);
  });

  it("session state takes precedence over saved dirs", () => {
    const cwd = tmpProjectDir;
    const dirA = path.join(tmpProjectDir, "dir-a");
    const dirB = path.join(tmpProjectDir, "dir-b");
    const dirC = path.join(tmpProjectDir, "dir-c");
    mkdirp(dirA);
    mkdirp(dirB);
    mkdirp(dirC);

    // Save dirs A and B to persistent storage
    saveSavedDirs(cwd, [
      { absolutePath: dirA, label: "dir-a", addedAt: 1000 },
      { absolutePath: dirB, label: "dir-b", addedAt: 1000 },
    ]);

    // Session has dir C already
    const ext = new SimulatedExtension();
    ext.sessionEntries = [{
      type: "custom",
      customType: "add-dir:state",
      data: { dirs: [{ absolutePath: dirC, label: "dir-c", addedAt: 2000 }] },
    }];
    ext.reconstructState(cwd);

    // Should have C (from session) + A and B (from saved dirs)
    expect(ext.addedDirs.length).toBe(3);
    const paths = ext.addedDirs.map(d => d.absolutePath);
    expect(paths).toContain(dirA);
    expect(paths).toContain(dirB);
    expect(paths).toContain(dirC);
  });

  it("removing a dir also removes from saved dirs", () => {
    const cwd = tmpProjectDir;
    const dirA = path.join(tmpProjectDir, "dir-a");
    const dirB = path.join(tmpProjectDir, "dir-b");
    mkdirp(dirA);
    mkdirp(dirB);

    // Add both dirs
    const ext = new SimulatedExtension();
    ext.reconstructState(cwd);
    ext.addDir(dirA);
    ext.addDir(dirB);

    // Remove dirA
    ext.removeDir(dirA);

    // Saved dirs should only have dirB
    const saved = loadSavedDirs(cwd);
    expect(saved.length).toBe(1);
    expect(saved[0].absolutePath).toBe(dirB);

    // New session should only load dirB
    const ext2 = new SimulatedExtension();
    ext2.reconstructState(cwd);
    expect(ext2.addedDirs.length).toBe(1);
    expect(ext2.addedDirs[0].absolutePath).toBe(dirB);
  });

  it("different cwds have independent saved dirs", () => {
    const cwdAlpha = path.join(tmpProjectDir, "alpha");
    const cwdBeta = path.join(tmpProjectDir, "beta");
    const dirA = path.join(tmpProjectDir, "lib-a");
    const dirB = path.join(tmpProjectDir, "lib-b");
    mkdirp(cwdAlpha);
    mkdirp(cwdBeta);
    mkdirp(dirA);
    mkdirp(dirB);

    // Session in alpha: add dirA
    const extAlpha = new SimulatedExtension();
    extAlpha.reconstructState(cwdAlpha);
    extAlpha.addDir(dirA);

    // Session in beta: add dirB
    const extBeta = new SimulatedExtension();
    extBeta.reconstructState(cwdBeta);
    extBeta.addDir(dirB);

    // New session in alpha should only get dirA
    const extAlpha2 = new SimulatedExtension();
    extAlpha2.reconstructState(cwdAlpha);
    expect(extAlpha2.addedDirs.length).toBe(1);
    expect(extAlpha2.addedDirs[0].absolutePath).toBe(dirA);

    // New session in beta should only get dirB
    const extBeta2 = new SimulatedExtension();
    extBeta2.reconstructState(cwdBeta);
    expect(extBeta2.addedDirs.length).toBe(1);
    expect(extBeta2.addedDirs[0].absolutePath).toBe(dirB);
  });

  it("clear-saved-dirs prevents auto-load on next session", () => {
    const cwd = tmpProjectDir;
    const dirA = path.join(tmpProjectDir, "dir-a");
    mkdirp(dirA);

    // Add a dir
    const ext1 = new SimulatedExtension();
    ext1.reconstructState(cwd);
    ext1.addDir(dirA);

    // Clear saved dirs
    clearSavedDirs(cwd);

    // New session should NOT auto-load
    const ext2 = new SimulatedExtension();
    ext2.reconstructState(cwd);
    expect(ext2.addedDirs.length).toBe(0);
  });

  it("works across cwd with spaces and special chars", () => {
    const cwd = path.join(tmpProjectDir, "my project");
    const dirA = path.join(tmpProjectDir, "shared lib");
    mkdirp(cwd);
    mkdirp(dirA);

    const ext1 = new SimulatedExtension();
    ext1.reconstructState(cwd);
    ext1.addDir(dirA);

    const ext2 = new SimulatedExtension();
    ext2.reconstructState(cwd);
    expect(ext2.addedDirs.length).toBe(1);
    expect(ext2.addedDirs[0].absolutePath).toBe(dirA);
  });

  it("saved dirs survive all dirs being deleted and re-created", () => {
    const cwd = tmpProjectDir;
    const dirA = path.join(tmpProjectDir, "dir-a");
    mkdirp(dirA);

    // Add dir
    const ext1 = new SimulatedExtension();
    ext1.reconstructState(cwd);
    ext1.addDir(dirA);

    // Delete dirA from disk
    fs.rmSync(dirA, { recursive: true, force: true });

    // New session: dirA should be pruned
    const ext2 = new SimulatedExtension();
    ext2.reconstructState(cwd);
    expect(ext2.addedDirs.length).toBe(0);

    // Re-create dirA on disk
    mkdirp(dirA);

    // Reload saved dirs should NOT auto-add dirA because
    // it was pruned from the saved dirs file when the path was gone
    const ext3 = new SimulatedExtension();
    ext3.reconstructState(cwd);
    expect(ext3.addedDirs.length).toBe(0);
  });

  it("handles add after clear-saved-dirs", () => {
    const cwd = tmpProjectDir;
    const dirA = path.join(tmpProjectDir, "dir-a");
    const dirB = path.join(tmpProjectDir, "dir-b");
    mkdirp(dirA);
    mkdirp(dirB);

    // Add dirA
    const ext1 = new SimulatedExtension();
    ext1.reconstructState(cwd);
    ext1.addDir(dirA);

    // Clear saved dirs
    clearSavedDirs(cwd);

    // Add dirB (should save dirB to a fresh saved dirs file)
    const ext2 = new SimulatedExtension();
    ext2.reconstructState(cwd);
    ext2.addDir(dirB);

    // Next session should only have dirB
    const ext3 = new SimulatedExtension();
    ext3.reconstructState(cwd);
    expect(ext3.addedDirs.length).toBe(1);
    expect(ext3.addedDirs[0].absolutePath).toBe(dirB);
  });
});
