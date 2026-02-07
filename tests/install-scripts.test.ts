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
async function runBunScript(script: string, env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync("bun", ["-e", script], {
    timeout: 10_000,
    cwd: testDir,
    env: { ...process.env, ...env },
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
      const path = process.env.SETTINGS_PATH;
      const hookCmd = process.env.HOOK_CMD;

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

      const existing = settings.hooks.SessionEnd.find(
        (entry) => entry.hooks?.some((h) => h.command?.includes('signal-tagger'))
      );
      if (!existing) {
        settings.hooks.SessionEnd.push({
          matcher: '',
          hooks: [{ type: 'command', command: hookCmd, timeout: 15 }],
        });
      }

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `, { SETTINGS_PATH: settingsPath, HOOK_CMD: hookCmd });

    const result = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(result.hooks.SessionEnd).toHaveLength(1);
    expect(result.hooks.SessionEnd[0].hooks[0].command).toBe(hookCmd);
    expect(result.hooks.SessionEnd[0].hooks[0].timeout).toBe(15);
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
      const path = process.env.SETTINGS_PATH;
      const hookCmd = process.env.HOOK_CMD;

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

      const exists = settings.hooks.SessionEnd.find(
        (entry) => entry.hooks?.some((h) => h.command?.includes('signal-tagger'))
      );
      if (!exists) {
        settings.hooks.SessionEnd.push({
          matcher: '',
          hooks: [{ type: 'command', command: hookCmd, timeout: 15 }],
        });
      }

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `, { SETTINGS_PATH: settingsPath, HOOK_CMD: hookCmd });

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
          { matcher: "", hooks: [{ type: "command", command: hookCmd, timeout: 15 }] },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(existing), "utf-8");

    await runBunScript(`
      const fs = require('fs');
      const path = process.env.SETTINGS_PATH;
      const hookCmd = process.env.HOOK_CMD;

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

      const exists = settings.hooks.SessionEnd.find(
        (entry) => entry.hooks?.some((h) => h.command?.includes('signal-tagger'))
      );
      if (!exists) {
        settings.hooks.SessionEnd.push({
          matcher: '',
          hooks: [{ type: 'command', command: hookCmd, timeout: 15 }],
        });
      }

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `, { SETTINGS_PATH: settingsPath, HOOK_CMD: hookCmd });

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
      const path = process.env.SETTINGS_PATH;

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

      settings.hooks.SessionEnd.push({
        matcher: '',
        hooks: [{ type: 'command', command: 'signal-tagger.ts', timeout: 15 }],
      });

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `, { SETTINGS_PATH: settingsPath });

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
      const path = process.env.SETTINGS_PATH;
      const hookFilter = process.env.HOOK_FILTER;

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!settings.hooks?.SessionEnd) process.exit(0);
      const before = settings.hooks.SessionEnd.length;
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes(hookFilter))
      );
      if (before === settings.hooks.SessionEnd.length) process.exit(0);
      if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `, { SETTINGS_PATH: settingsPath, HOOK_FILTER: "signal-tagger" });

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
      const path = process.env.SETTINGS_PATH;
      const hookFilter = process.env.HOOK_FILTER;

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!settings.hooks?.SessionEnd) process.exit(0);
      const before = settings.hooks.SessionEnd.length;
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes(hookFilter))
      );
      if (before === settings.hooks.SessionEnd.length) process.exit(0);
      if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `, { SETTINGS_PATH: settingsPath, HOOK_FILTER: "signal-tagger" });

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
      const path = process.env.SETTINGS_PATH;
      const hookFilter = process.env.HOOK_FILTER;

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!settings.hooks?.SessionEnd) process.exit(0);
      const before = settings.hooks.SessionEnd.length;
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes(hookFilter))
      );
      if (before === settings.hooks.SessionEnd.length) process.exit(0);
      if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `, { SETTINGS_PATH: settingsPath, HOOK_FILTER: "signal-tagger" });

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
      const path = process.env.SETTINGS_PATH;
      const hookFilter = process.env.HOOK_FILTER;

      let settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!settings.hooks?.SessionEnd) process.exit(0);
      const before = settings.hooks.SessionEnd.length;
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes(hookFilter))
      );
      if (before === settings.hooks.SessionEnd.length) process.exit(0);
      if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

      fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
    `, { SETTINGS_PATH: settingsPath, HOOK_FILTER: "signal-tagger" });

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

  it("xml_escape handles special characters", async () => {
    // Replicate the xml_escape logic from install.sh
    const result = await runBunScript(`
      function xmlEscape(s) {
        s = s.replace(/&/g, '&amp;');
        s = s.replace(/</g, '&lt;');
        s = s.replace(/>/g, '&gt;');
        s = s.replace(/"/g, '&quot;');
        s = s.replace(/'/g, '&apos;');
        return s;
      }
      const tests = [
        { input: '/normal/path', expected: '/normal/path' },
        { input: 'a&b', expected: 'a&amp;b' },
        { input: '<tag>', expected: '&lt;tag&gt;' },
        { input: 'say "hello"', expected: 'say &quot;hello&quot;' },
        { input: "it's", expected: "it&apos;s" },
        { input: 'a&b<c>d"e\\'f', expected: "a&amp;b&lt;c&gt;d&quot;e&apos;f" },
      ];
      for (const t of tests) {
        const got = xmlEscape(t.input);
        if (got !== t.expected) {
          console.error('FAIL: xmlEscape(' + JSON.stringify(t.input) + ') = ' + JSON.stringify(got) + ', want ' + JSON.stringify(t.expected));
          process.exit(1);
        }
      }
      console.log('OK');
    `);
    expect(result.trim()).toBe("OK");
  });
});
