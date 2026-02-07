import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFile, writeFile, mkdir, rm, readdir, symlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Test helpers ────────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `signals-install-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// Run a bun script in the test directory to simulate the JSON manipulation
// that install.sh and uninstall.sh perform
async function runBunScript(script: string): Promise<string> {
  const { stdout } = await execFileAsync("bun", ["-e", script], {
    timeout: 10_000,
    cwd: testDir,
  });
  return stdout;
}

// ── Hook registration (install logic) ───────────────────────────────

describe("hook registration", () => {
  it("adds hook to empty settings.json", async () => {
    const settingsPath = join(testDir, "settings.json");
    await writeFile(settingsPath, "{}", "utf-8");

    const hookCmd = "/home/user/.claude/signals/signal-tagger.ts";
    await runBunScript(`
      const fs = require('fs');
      const path = '${settingsPath}';
      const hookCmd = '${hookCmd}';

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

      const existing = settings.hooks.SessionEnd.find(
        (entry) => entry.hooks?.some((h) => h.command?.includes('signal-tagger'))
      );
      if (!existing) {
        settings.hooks.SessionEnd.push({
          matcher: '',
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }],
        });
      }

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `);

    const result = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(result.hooks.SessionEnd).toHaveLength(1);
    expect(result.hooks.SessionEnd[0].hooks[0].command).toBe(hookCmd);
    expect(result.hooks.SessionEnd[0].hooks[0].timeout).toBe(5);
    expect(result.hooks.SessionEnd[0].hooks[0].type).toBe("command");
    expect(result.hooks.SessionEnd[0].matcher).toBe("");
  });

  it("preserves existing hooks when adding", async () => {
    const settingsPath = join(testDir, "settings.json");
    const existing = {
      hooks: {
        SessionEnd: [
          { matcher: "", hooks: [{ type: "command", command: "some-other-hook", timeout: 10 }] },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(existing), "utf-8");

    const hookCmd = "/home/user/.claude/signals/signal-tagger.ts";
    await runBunScript(`
      const fs = require('fs');
      const path = '${settingsPath}';
      const hookCmd = '${hookCmd}';

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

      const exists = settings.hooks.SessionEnd.find(
        (entry) => entry.hooks?.some((h) => h.command?.includes('signal-tagger'))
      );
      if (!exists) {
        settings.hooks.SessionEnd.push({
          matcher: '',
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }],
        });
      }

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `);

    const result = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(result.hooks.SessionEnd).toHaveLength(2);
    expect(result.hooks.SessionEnd[0].hooks[0].command).toBe("some-other-hook");
    expect(result.hooks.SessionEnd[1].hooks[0].command).toBe(hookCmd);
  });

  it("is idempotent — does not duplicate hook", async () => {
    const settingsPath = join(testDir, "settings.json");
    const hookCmd = "/home/user/.claude/signals/signal-tagger.ts";
    const existing = {
      hooks: {
        SessionEnd: [
          { matcher: "", hooks: [{ type: "command", command: hookCmd, timeout: 5 }] },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(existing), "utf-8");

    await runBunScript(`
      const fs = require('fs');
      const path = '${settingsPath}';
      const hookCmd = '${hookCmd}';

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

      const exists = settings.hooks.SessionEnd.find(
        (entry) => entry.hooks?.some((h) => h.command?.includes('signal-tagger'))
      );
      if (!exists) {
        settings.hooks.SessionEnd.push({
          matcher: '',
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }],
        });
      }

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `);

    const result = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(result.hooks.SessionEnd).toHaveLength(1);
  });

  it("preserves other settings keys", async () => {
    const settingsPath = join(testDir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      theme: "dark",
      model: "opus",
    }), "utf-8");

    await runBunScript(`
      const fs = require('fs');
      const path = '${settingsPath}';

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

      settings.hooks.SessionEnd.push({
        matcher: '',
        hooks: [{ type: 'command', command: 'signal-tagger.ts', timeout: 5 }],
      });

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `);

    const result = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(result.theme).toBe("dark");
    expect(result.model).toBe("opus");
    expect(result.hooks.SessionEnd).toHaveLength(1);
  });
});

// ── Hook removal (uninstall logic) ──────────────────────────────────

describe("hook removal", () => {
  it("removes signal-tagger hook and preserves others", async () => {
    const settingsPath = join(testDir, "settings.json");
    const settings = {
      hooks: {
        SessionEnd: [
          { matcher: "", hooks: [{ type: "command", command: "other-hook" }] },
          { matcher: "", hooks: [{ type: "command", command: "/path/to/signal-tagger.ts" }] },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(settings), "utf-8");

    await runBunScript(`
      const fs = require('fs');
      const path = '${settingsPath}';

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes('signal-tagger'))
      );
      if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `);

    const result = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(result.hooks.SessionEnd).toHaveLength(1);
    expect(result.hooks.SessionEnd[0].hooks[0].command).toBe("other-hook");
  });

  it("removes hooks key when SessionEnd is the only hook type", async () => {
    const settingsPath = join(testDir, "settings.json");
    const settings = {
      theme: "dark",
      hooks: {
        SessionEnd: [
          { matcher: "", hooks: [{ type: "command", command: "signal-tagger.ts" }] },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(settings), "utf-8");

    await runBunScript(`
      const fs = require('fs');
      const path = '${settingsPath}';

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes('signal-tagger'))
      );
      if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `);

    const result = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(result.hooks).toBeUndefined();
    expect(result.theme).toBe("dark");
  });

  it("preserves hooks key when other hook types exist", async () => {
    const settingsPath = join(testDir, "settings.json");
    const settings = {
      hooks: {
        SessionEnd: [
          { matcher: "", hooks: [{ type: "command", command: "signal-tagger.ts" }] },
        ],
        PreToolUse: [
          { matcher: "", hooks: [{ type: "command", command: "some-hook" }] },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(settings), "utf-8");

    await runBunScript(`
      const fs = require('fs');
      const path = '${settingsPath}';

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes('signal-tagger'))
      );
      if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `);

    const result = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(result.hooks).toBeDefined();
    expect(result.hooks.SessionEnd).toBeUndefined();
    expect(result.hooks.PreToolUse).toHaveLength(1);
  });

  it("handles no matching hooks gracefully", async () => {
    const settingsPath = join(testDir, "settings.json");
    const settings = {
      hooks: {
        SessionEnd: [
          { matcher: "", hooks: [{ type: "command", command: "other-hook" }] },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(settings), "utf-8");

    await runBunScript(`
      const fs = require('fs');
      const path = '${settingsPath}';

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes('signal-tagger'))
      );
      if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `);

    const result = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(result.hooks.SessionEnd).toHaveLength(1);
    expect(result.hooks.SessionEnd[0].hooks[0].command).toBe("other-hook");
  });
});

// ── Directory and symlink setup ─────────────────────────────────────

describe("directory and symlink setup", () => {
  it("creates nested directories", async () => {
    const dir = join(testDir, "a", "b", "c");
    await mkdir(dir, { recursive: true });
    const entries = await readdir(join(testDir, "a", "b"));
    expect(entries).toContain("c");
  });

  it("creates and verifies symlink", async () => {
    const source = join(testDir, "source.ts");
    const target = join(testDir, "target.ts");
    await writeFile(source, "content", "utf-8");
    await symlink(source, target);

    const stat = await lstat(target);
    expect(stat.isSymbolicLink()).toBe(true);

    const content = await readFile(target, "utf-8");
    expect(content).toBe("content");
  });

  it("symlink is idempotent (replace existing)", async () => {
    const source1 = join(testDir, "source1.ts");
    const source2 = join(testDir, "source2.ts");
    const target = join(testDir, "target.ts");

    await writeFile(source1, "old", "utf-8");
    await writeFile(source2, "new", "utf-8");

    await symlink(source1, target);
    // Remove and re-symlink (simulating install.sh behavior)
    await rm(target);
    await symlink(source2, target);

    const content = await readFile(target, "utf-8");
    expect(content).toBe("new");
  });
});

// ── launchd plist structure ─────────────────────────────────────────

describe("launchd plist structure", () => {
  it("generates valid plist XML", () => {
    const label = "com.session-signals.daily-analysis";
    const bunPath = "/usr/local/bin/bun";
    const analyzerPath = "/path/to/pattern-analyzer.ts";

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bunPath}</string>
        <string>${analyzerPath}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>0</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
</dict>
</plist>`;

    expect(plist).toContain(label);
    expect(plist).toContain(bunPath);
    expect(plist).toContain(analyzerPath);
    expect(plist).toContain("<integer>0</integer>");
    expect(plist).toContain("StartCalendarInterval");
  });

  it("includes correct label", () => {
    const label = "com.session-signals.daily-analysis";
    expect(label).toMatch(/^com\.session-signals\./);
  });
});
