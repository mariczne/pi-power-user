import test from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { ansi, getFgAnsiCode } from "../colors.ts";
import { isSupportedSuperShortcut, matchesConfiguredShortcut, shortcutConflictKey } from "../shortcuts.ts";
import { readFileSync } from "node:fs";
import { KeybindingsManager } from "@earendil-works/pi-tui";
import { KEYBINDINGS } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
  buildShortcutPaletteEntries,
  collectPiKeybindingDefinitions,
  getPowerlineShortcutHelpEntries,
  isModalScopedKeybinding,
  isShortcutPaletteQueryInput,
  parseBashModeSettings,
  piShortcutGroupPrefix,
  renderFastPowerlineEditor,
  resolveShortcutConfig,
  shortcutPaletteItemDescription,
} from "../index.ts";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");

test("surviving editor shortcuts resolve without app-owned chat scrolling", () => {
  const resolved = resolveShortcutConfig({});
  assert.equal(resolved.showShortcuts, "ctrl+shift+k");
  assert.equal(resolved.stashHistory, "ctrl+alt+h");
  assert.equal(resolved.copyEditor, "ctrl+alt+c");
  assert.equal(resolved.cutEditor, "ctrl+alt+x");
  assert.equal(resolved.reply, null);
  assert.equal(resolved.editorStart, "super+shift+up");
  assert.equal(resolved.editorEnd, "super+shift+down");
  assert.equal(Object.keys(resolved).some((key) => key.startsWith("scroll")), false);
  assert.equal(Object.keys(resolved).some((key) => key.startsWith("jump")), false);
});

test("super shortcut matching and conflict normalization remain supported", () => {
  assert.equal(matchesConfiguredShortcut("\x1b[1;9A", "super+up"), true);
  assert.equal(matchesConfiguredShortcut("c", "super+c"), false);
  assert.equal(isSupportedSuperShortcut("super+up"), true);
  assert.equal(isSupportedSuperShortcut("super+z"), false);
  assert.equal(shortcutConflictKey("super+home"), "super+up");
});


test("editor boundary shortcuts remain configurable", () => {
  const resolved = resolveShortcutConfig({
    powerlineShortcuts: {
      editorStart: "ctrl+shift+u",
      editorEnd: "ctrl+shift+d",
    },
  });

  assert.equal(resolved.editorStart, "ctrl+shift+u");
  assert.equal(resolved.editorEnd, "ctrl+shift+d");
});

test("reply shortcut is opt-in and configurable", () => {
  assert.equal(resolveShortcutConfig({ powerlineShortcuts: { reply: null } }).reply, null);
  assert.equal(resolveShortcutConfig({ powerlineShortcuts: { reply: "ctrl+shift+r" } }).reply, "ctrl+shift+r");
});

test("conflicting reply shortcut disables reply instead of borrowing another action", () => {
  const reserved = resolveShortcutConfig({ powerlineShortcuts: { reply: "ctrl+r" } });
  assert.equal(reserved.reply, null);
  assert.equal(reserved.editorStart, "super+shift+up");
  assert.equal(reserved.editorEnd, "super+shift+down");

  const duplicate = resolveShortcutConfig({ powerlineShortcuts: { reply: "ctrl+alt+h" } });
  assert.equal(duplicate.reply, null);
  assert.equal(duplicate.stashHistory, "ctrl+alt+h");

  const editorStartDefault = resolveShortcutConfig({ powerlineShortcuts: { reply: "super+shift+up" } });
  assert.equal(editorStartDefault.reply, null);
  assert.equal(editorStartDefault.editorStart, "super+shift+up");
  assert.equal(editorStartDefault.editorEnd, "super+shift+down");

  const editorEndDefault = resolveShortcutConfig({ powerlineShortcuts: { reply: "super+shift+down" } });
  assert.equal(editorEndDefault.reply, null);
  assert.equal(editorEndDefault.editorStart, "super+shift+up");
  assert.equal(editorEndDefault.editorEnd, "super+shift+down");
});

test("bash completions are opt-in", () => {
  assert.equal(parseBashModeSettings({}).completions, false);
  assert.equal(parseBashModeSettings({ bashMode: { completions: true } }).completions, true);
  assert.equal(parseBashModeSettings({ bashMode: { completions: false } }).completions, false);
});

test("fast editor render keeps Powerline chrome for large drafts", () => {
  const editor: Record<string, any> = {
    focused: true,
    isShowingAutocomplete: () => false,
    tui: { terminal: { rows: 24 } },
  };
  editor.borderColor = function (text: string) {
    assert.equal(this, editor);
    return `\x1b[31m${text}\x1b[0m`;
  };
  Reflect.set(editor, "state", {
    lines: ["intro", "x".repeat(5000)],
    cursorLine: 1,
    cursorCol: 5000,
  });

  const rendered = renderFastPowerlineEditor(editor, 80, {
    bashModeActive: false,
    completionsEnabled: false,
  });

  assert.ok(rendered);
  assert.ok(rendered[0]?.includes("↑"));
  assert.ok(rendered[0]?.startsWith(" \x1b[31m"));
  assert.ok(rendered.at(-1)?.startsWith(" \x1b[31m"));
  assert.ok(rendered.some((line) => line.includes(CURSOR_MARKER)));
  assert.ok(rendered.some((line) => line.includes(">")));

  editor.borderColor = (text: string) => `\x1b[34m${text}\x1b[0m`;
  const recolored = renderFastPowerlineEditor(editor, 80, {
    bashModeActive: false,
    completionsEnabled: false,
  });
  assert.ok(recolored?.[0]?.startsWith(" \x1b[34m"));
  assert.ok(recolored?.at(-1)?.startsWith(" \x1b[34m"));

  delete editor.borderColor;
  const fallback = renderFastPowerlineEditor(editor, 80, {
    bashModeActive: false,
    completionsEnabled: false,
  });
  assert.ok(fallback?.[0]?.startsWith(` ${getFgAnsiCode("sep")}`));
  assert.ok(fallback?.[0]?.endsWith(ansi.reset));
});

test("fast editor render falls back for short drafts and enabled completions", () => {
  const editor = {
    focused: true,
    isShowingAutocomplete: () => false,
    tui: { terminal: { rows: 24 } },
  };
  Reflect.set(editor, "state", { lines: ["short"], cursorLine: 0, cursorCol: 5 });

  assert.equal(renderFastPowerlineEditor(editor, 80, {
    bashModeActive: false,
    completionsEnabled: false,
  }), null);

  Reflect.set(editor, "state", { lines: ["x".repeat(5000)], cursorLine: 0, cursorCol: 5000 });
  assert.equal(renderFastPowerlineEditor(editor, 80, {
    bashModeActive: false,
    completionsEnabled: true,
  }), null);
});

test("fast editor render falls back for wide characters", () => {
  const editor = {
    focused: true,
    isShowingAutocomplete: () => false,
    tui: { terminal: { rows: 24 } },
  };
  Reflect.set(editor, "state", { lines: ["漢".repeat(1300)], cursorLine: 0, cursorCol: 1291 });

  assert.equal(renderFastPowerlineEditor(editor, 80, {
    bashModeActive: false,
    completionsEnabled: false,
  }), null);
});

test("fast editor render updates the editor navigation width", () => {
  const editor = {
    focused: true,
    isShowingAutocomplete: () => false,
    lastWidth: 12,
    tui: { terminal: { rows: 24 } },
  };
  Reflect.set(editor, "state", { lines: ["x".repeat(5000)], cursorLine: 0, cursorCol: 5000 });

  assert.ok(renderFastPowerlineEditor(editor, 80, {
    bashModeActive: false,
    completionsEnabled: false,
  }));
  assert.equal(Reflect.get(editor, "lastWidth"), 76);
});

test("powerline shortcut help lists active bindings and omits disabled bindings", () => {
  const entries = getPowerlineShortcutHelpEntries({
    showShortcuts: null,
    stashHistory: null,
    copyEditor: "ctrl+alt+c",
    cutEditor: null,
    queueOpen: null,
    reply: null,
    editorStart: "super+shift+up",
    editorEnd: null,
  }, "ctrl+shift+b");

  assert.deepEqual(entries, [
    { key: "stash", label: "Stash or restore editor", shortcut: "alt+s" },
    { key: "bashToggle", label: "Toggle bash mode", shortcut: "ctrl+shift+b" },
    { key: "copyEditor", label: "Copy editor text", shortcut: "ctrl+alt+c" },
    { key: "editorStart", label: "Move editor to start", shortcut: "cmd+shift+up" },
  ]);
  assert.match(source, /runShortcutPaletteEntry\(ctx, selected\)/);
  assert.match(source, /if \(normalizedArgs === "shortcuts"\)/);
  assert.match(source, /theme\.bold\("Shortcuts"\)/);
});

test("shortcut palette merges powerline and pi bindings with search-friendly metadata", () => {
  const powerlineEntries = getPowerlineShortcutHelpEntries(resolveShortcutConfig({}), "ctrl+shift+b");
  const runnableIds = new Set(["app.model.select", "app.session.resume", "app.clipboard.pasteImage"]);

  const manager = new KeybindingsManager(KEYBINDINGS, { "app.model.select": "ctrl+alt+m" });
  const piKeybindings = collectPiKeybindingDefinitions(manager);
  assert.deepEqual(collectPiKeybindingDefinitions(undefined), {});

  const entries = buildShortcutPaletteEntries({
    powerlineEntries,
    piKeybindings,
    isPiActionRunnable: (id) => runnableIds.has(id),
  });

  // Every powerline entry is present, prefixed, and runnable.
  for (const entry of powerlineEntries) {
    const paletteEntry = entries.find((candidate) => candidate.id === `powerline:${entry.key}`);
    assert.ok(paletteEntry, `missing palette entry for powerline:${entry.key}`);
    assert.equal(paletteEntry.label, `Powerline: ${entry.label}`);
    assert.equal(paletteEntry.runnable, true);
  }

  // Every pi keybinding is present exactly once — except modal-scoped ones,
  // which can never run from the palette and are hinted inside their own UIs.
  for (const id of Object.keys(KEYBINDINGS)) {
    const expected = isModalScopedKeybinding(id) && !runnableIds.has(id) ? 0 : 1;
    assert.equal(entries.filter((candidate) => candidate.id === `pi:${id}`).length, expected, id);
  }
  assert.equal(entries.find((entry) => entry.id === "pi:app.tree.filter.all"), undefined);
  assert.equal(entries.find((entry) => entry.id === "pi:app.session.delete"), undefined);
  assert.equal(entries.find((entry) => entry.id === "pi:tui.select.confirm"), undefined);
  assert.ok(entries.find((entry) => entry.id === "pi:tui.editor.deleteWordBackward"));

  // Modal-scoped classification.
  assert.equal(isModalScopedKeybinding("app.tree.filter.all"), true);
  assert.equal(isModalScopedKeybinding("app.models.save"), true);
  assert.equal(isModalScopedKeybinding("app.session.rename"), true);
  assert.equal(isModalScopedKeybinding("tui.select.up"), true);
  assert.equal(isModalScopedKeybinding("tui.editor.undo"), false);
  assert.equal(isModalScopedKeybinding("app.session.resume"), false);
  assert.equal(isModalScopedKeybinding("app.interrupt"), false);

  // Configured keys override defaults; unconfigured fall back to defaults.
  const modelSelect = entries.find((entry) => entry.id === "pi:app.model.select");
  assert.equal(modelSelect?.shortcut, "ctrl+alt+m");
  assert.equal(modelSelect?.runnable, true);
  const undo = entries.find((entry) => entry.id === "pi:tui.editor.undo");
  assert.equal(undo?.shortcut, "ctrl+-");
  assert.equal(undo?.runnable, false);

  // Unbound-but-runnable app actions still appear as commands.
  const resume = entries.find((entry) => entry.id === "pi:app.session.resume");
  assert.equal(resume?.shortcut, "");
  assert.equal(resume?.runnable, true);

  // Runnable entries are listed before reference-only entries.
  const lastRunnable = entries.reduce((last, entry, index) => (entry.runnable ? index : last), -1);
  const firstReference = entries.findIndex((entry) => !entry.runnable);
  assert.ok(lastRunnable < firstReference || firstReference === -1);

  // Context-scoped bindings get group prefixes.
  assert.equal(piShortcutGroupPrefix("tui.editor.undo"), "Editor: ");
  assert.equal(piShortcutGroupPrefix("tui.select.confirm"), "Lists: ");
  assert.equal(piShortcutGroupPrefix("app.tree.filter.all"), "Tree view: ");
  assert.equal(piShortcutGroupPrefix("app.models.save"), "Model selector: ");
  assert.equal(piShortcutGroupPrefix("app.session.delete"), "Session picker: ");
  assert.equal(piShortcutGroupPrefix("app.model.select"), "");

  // Reference-only entries are marked in the description column.
  assert.equal(
    shortcutPaletteItemDescription({ id: "pi:tui.editor.undo", label: "Editor: Undo", shortcut: "ctrl+-", runnable: false }),
    "ctrl+- · reference",
  );
  assert.equal(
    shortcutPaletteItemDescription({ id: "pi:app.session.resume", label: "Resume a session", shortcut: "", runnable: true }),
    undefined,
  );

  // Dangerous or palette-redundant actions never run from the palette.
  assert.match(source, /PI_PALETTE_RUN_EXCLUDED = new Set\(\["app\.interrupt", "app\.exit", "app\.clear"\]\)/);
  // App actions execute through the handlers pi copies onto the custom editor.
  assert.match(source, /const handlers = currentEditor\?\.actionHandlers/);
  assert.match(source, /handlers instanceof Map \? handlers\.get\(actionId\) : undefined/);
});

test("shortcut palette query input accepts printable text and rejects control sequences", () => {
  assert.equal(isShortcutPaletteQueryInput("a"), true);
  assert.equal(isShortcutPaletteQueryInput("model select"), true);
  assert.equal(isShortcutPaletteQueryInput("ß"), true);
  assert.equal(isShortcutPaletteQueryInput(""), false);
  assert.equal(isShortcutPaletteQueryInput("\x1b[A"), false);
  assert.equal(isShortcutPaletteQueryInput("\x0b"), false);
  assert.equal(isShortcutPaletteQueryInput("\x7f"), false);
  assert.equal(isShortcutPaletteQueryInput("\x1bs"), false);
});
