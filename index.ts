import {
  copyToClipboard,
  type ExtensionAPI,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CURSOR_MARKER, fuzzyFilter, isKeyRelease, matchesKey, type AutocompleteProvider, type SelectItem, SelectList, truncateToWidth, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

import type { ColorScheme, SegmentContext, StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle } from "./types.ts";
import type { PowerlineConfig } from "./powerline-config.ts";
import { BashTranscriptStore } from "./bash-mode/transcript.ts";
import {
  BashCompletionEngine,
  BashAutocompleteProvider,
  getOneOffBashCommandContext,
  ModeAwareAutocompleteProvider,
  OneOffBashAutocompleteProvider,
} from "./bash-mode/completion.ts";
import { BashModeEditor, isPrintableInput } from "./bash-mode/editor.ts";
import { ManagedShellSession } from "./bash-mode/shell-session.ts";
import { matchHistoryEntries, readGlobalShellHistory, readProjectHistory, appendProjectHistory } from "./bash-mode/history.ts";
import type { BashModeSettings } from "./bash-mode/types.ts";
import { getPreset, PRESETS } from "./presets.ts";
import { getAgentPath } from "./paths.ts";
import { collectHiddenExtensionStatusKeys, getNotificationExtensionStatuses, mergeSegmentOptions, mergeSegmentsWithCustomItems, nextPowerlineSettingWithOptions, nextPowerlineSettingWithPreset, parsePowerlineConfig } from "./powerline-config.ts";
import { getSeparator } from "./separators.ts";
import { renderSegment } from "./segments.ts";
import { resolveThinkingLevelSelection } from "./thinking-level.ts";
import { getGitStatus, invalidateGitStatus, invalidateGitBranch, subscribeGitUpdates } from "./git-status.ts";
import { SessionBranchCache, SessionTokenStatsCache } from "./token-stats.ts";
import { ansi, getFgAnsiCode } from "./colors.ts";
import { WelcomeComponent, WelcomeHeader, discoverLoadedCounts, getRecentSessions } from "./welcome.ts";
import { createRenderScheduler } from "./render-scheduler.ts";
import { getEditorAutocompleteProvider, passAutocompleteProviderThroughPreviousEditor } from "./editor-composition.ts";
import { CoreContextUsageCache, estimateInitialContextTokens, estimateUnknownContextUsage, resolveDisplayContextUsage, type CoreContextUsage } from "./context-usage.ts";
import { isStaleExtensionContextError, shouldShowStartupWelcome } from "./lifecycle.ts";
import { getDefaultColors } from "./theme.ts";
import { fetchProviderSubscriptionUsage, getSupportedSubscriptionProvider, isSubscriptionUsageEnabled, type SubscriptionUsage } from "./subscription-usage.ts";
import { registerCdCommand } from "./cd-command.ts";
import {
  isSupportedSuperShortcut,
  matchesConfiguredShortcut,
  matchesCtrlSStashInput,
  matchesStashShortcutInput,
  shortcutConflictKey,
  shortcutUsesSuper,
} from "./shortcuts.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

let config: PowerlineConfig = {
  preset: "default",
  customItems: [],
  disabledSegments: [],
  invalidDisabledSegments: [],
  layout: null,
  invalidLayoutSegments: [],
  separator: null,
  segmentOptions: {},
  placement: "above",
  invalidPlacement: null,
  secondaryOverflow: "drop",
  invalidSecondaryOverflow: null,
  welcome: false,
  stashSharpSShortcut: false,
  sendDelayMs: 0,
};

const CUSTOM_COMPACTION_STATUS_KEY = "compact-policy";
let customCompactionEnabled = false;

type ShortcutBinding = string | null;

export interface PowerlineShortcuts {
  showShortcuts: ShortcutBinding;
  stashHistory: ShortcutBinding;
  copyEditor: ShortcutBinding;
  cutEditor: ShortcutBinding;
  reply: ShortcutBinding;
  editorStart: ShortcutBinding;
  editorEnd: ShortcutBinding;
}

type PowerlineShortcutKey = keyof PowerlineShortcuts;
type PowerlineShortcutAction =
  | { kind: "showShortcuts" }
  | { kind: "stashHistory" }
  | { kind: "copyEditor" }
  | { kind: "cutEditor" }
  | { kind: "reply" }
  | { kind: "bashMode" };
const STASH_HISTORY_LIMIT = 12;
const PROJECT_PROMPT_HISTORY_LIMIT = 50;
const PROJECT_PROMPT_HISTORY_FILE_LIMIT = 50;
const PROJECT_PROMPT_HISTORY_MAX_BYTES = 3 * 1024 * 1024;
const PROJECT_PROMPT_HISTORY_FILE_MAX_BYTES = 64 * 1024;
const STASH_PREVIEW_WIDTH = 72;
const DEFAULT_SHORTCUTS: PowerlineShortcuts = {
  showShortcuts: "ctrl+shift+k",
  stashHistory: "ctrl+alt+h",
  copyEditor: "ctrl+alt+c",
  cutEditor: "ctrl+alt+x",
  reply: null,
  editorStart: "super+shift+up",
  editorEnd: "super+shift+down",
};
const DEFAULT_BASH_MODE_SETTINGS = {
  toggleShortcut: "ctrl+shift+b",
  completions: false,
  transcriptMaxLines: 2000,
  transcriptMaxBytes: 512 * 1024,
} as const satisfies BashModeSettings;
const SHORTCUT_KEYS: PowerlineShortcutKey[] = ["showShortcuts", "stashHistory", "copyEditor", "cutEditor", "reply", "editorStart", "editorEnd"];
const APP_RESERVED_SHORTCUTS = [
  "escape",
  "ctrl+c",
  "ctrl+d",
  "ctrl+z",
  "shift+tab",
  "ctrl+p",
  "shift+ctrl+p",
  "ctrl+l",
  "ctrl+o",
  "shift+ctrl+o",
  "ctrl+t",
  "ctrl+n",
  "ctrl+g",
  "alt+enter",
  "alt+up",
  "alt+down",
  "ctrl+v",
  "alt+v",
  "shift+l",
  "shift+t",
  "ctrl+s",
  "ctrl+r",
  "ctrl+backspace",
  "ctrl+a",
  "ctrl+x",
  "ctrl+u",
] as const;
const EXTRA_RESERVED_SHORTCUTS = ["alt+s"] as const;
const SHORTCUT_MODIFIER_ORDER = ["ctrl", "alt", "super", "shift"] as const;
const SHORTCUT_MODIFIERS = new Set<string>(SHORTCUT_MODIFIER_ORDER);
const SHORTCUT_NAMED_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
]);
const SHORTCUT_SYMBOL_KEYS = new Set([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
  "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "|", "~", "{", "}", ":", "<", ">", "?",
]);
const PROMPT_HISTORY_LIMIT = 100;
const LAYOUT_CACHE_TTL_MS = 250;
const STREAMING_LAYOUT_CACHE_TTL_MS = 1000;
const STATUS_RENDER_DEBOUNCE_MS = 33;
const CONTEXT_STATUS_RENDER_MS = 250;
const EDITOR_STATUS_DEFER_MS = 150;
const SUBSCRIPTION_USAGE_REFRESH_MS = 2 * 60 * 1000;
const SUBSCRIPTION_USAGE_RETRY_MS = 30 * 1000;
const PROMPT_HISTORY_TRACKED = Symbol.for("powerlinePromptHistoryTracked");
const PROMPT_HISTORY_STATE_KEY = Symbol.for("powerlinePromptHistoryState");
const ACTIVE_STASH_RELOAD_STATE_KEY = Symbol.for("pi-power-user.active-stash-reload.v1");

interface PromptHistoryEditor {
  addToHistory?: (text: string) => void;
}

type PromptHistoryState = { savedPromptHistory: string[] };
type ActiveStashReloadState = { version: 1; bySessionId: Map<string, string> };
type SessionAssistantUsage = AssistantMessage["usage"];
type SupportedSubscriptionProvider = NonNullable<ReturnType<typeof getSupportedSubscriptionProvider>>;

type CachedSubscriptionUsage = {
  usage: SubscriptionUsage | null;
  fetchedAt: number;
  error?: string;
};

const activeStashReloadState = (Reflect.get(globalThis, ACTIVE_STASH_RELOAD_STATE_KEY) as ActiveStashReloadState | undefined)
  ?? { version: 1, bySessionId: new Map<string, string>() };
Reflect.set(globalThis, ACTIVE_STASH_RELOAD_STATE_KEY, activeStashReloadState);

function getSessionId(ctx: any): string {
  return ctx.sessionManager.getSessionId();
}

function clearActiveStashReload(ctx: any): void {
  activeStashReloadState.bySessionId.delete(getSessionId(ctx));
}

function takeActiveStashReload(ctx: any): string | null {
  const sessionId = getSessionId(ctx);
  const transfers = activeStashReloadState.bySessionId;
  const text = transfers.get(sessionId) ?? null;
  transfers.delete(sessionId);
  return text;
}

function transferActiveStashReload(ctx: any, text: string | null): void {
  const transfers = activeStashReloadState.bySessionId;
  const sessionId = getSessionId(ctx);
  if (text === null) transfers.delete(sessionId);
  else transfers.set(sessionId, text);
}

function getUsageTokenTotal(usage: SessionAssistantUsage): number {
  const totalTokens = "totalTokens" in usage && typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
  return totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function hasSessionAssistantUsage(value: unknown): value is SessionAssistantUsage {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.input !== "number" ||
    typeof value.output !== "number" ||
    typeof value.cacheRead !== "number" ||
    typeof value.cacheWrite !== "number"
  ) {
    return false;
  }

  return isRecord(value.cost) && typeof value.cost.total === "number";
}

function isSessionAssistantMessage(value: unknown): value is AssistantMessage {
  return isRecord(value)
    && value.role === "assistant"
    && hasSessionAssistantUsage(value.usage)
    && (value.stopReason === undefined || typeof value.stopReason === "string");
}

function isPromptHistoryState(value: unknown): value is PromptHistoryState {
  return isRecord(value)
    && Array.isArray(value.savedPromptHistory)
    && value.savedPromptHistory.every((entry) => typeof entry === "string");
}

function getPromptHistoryState(): PromptHistoryState {
  const existing = Reflect.get(globalThis, PROMPT_HISTORY_STATE_KEY);
  if (isPromptHistoryState(existing)) {
    return existing;
  }

  const state: PromptHistoryState = { savedPromptHistory: [] };
  Reflect.set(globalThis, PROMPT_HISTORY_STATE_KEY, state);
  return state;
}

function readPromptHistory(editor: PromptHistoryEditor | null | undefined): string[] {
  if (!editor) return [];
  const history = Reflect.get(editor, "history");
  if (!Array.isArray(history)) return [];

  const normalized: string[] = [];
  for (const entry of history) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (normalized.length > 0 && normalized[normalized.length - 1] === trimmed) continue;
    normalized.push(trimmed);
    if (normalized.length >= PROMPT_HISTORY_LIMIT) break;
  }

  return normalized;
}

function snapshotPromptHistory(editor: PromptHistoryEditor | null | undefined): void {
  const history = readPromptHistory(editor);
  if (history.length > 0) {
    getPromptHistoryState().savedPromptHistory = [...history];
  }
}

function restorePromptHistory(editor: PromptHistoryEditor | null | undefined): void {
  const { savedPromptHistory } = getPromptHistoryState();
  if (!savedPromptHistory.length || typeof editor?.addToHistory !== "function") return;

  for (let i = savedPromptHistory.length - 1; i >= 0; i--) {
    editor.addToHistory(savedPromptHistory[i]);
  }
}

function trackPromptHistory(editor: PromptHistoryEditor | null | undefined): void {
  if (!editor || typeof editor.addToHistory !== "function") return;
  if (Reflect.get(editor, PROMPT_HISTORY_TRACKED)) {
    snapshotPromptHistory(editor);
    return;
  }

  const originalAddToHistory = editor.addToHistory.bind(editor);
  editor.addToHistory = (text: string) => {
    originalAddToHistory(text);
    snapshotPromptHistory(editor);
  };
  Reflect.set(editor, PROMPT_HISTORY_TRACKED, true);
  snapshotPromptHistory(editor);
}

function getSettingsPath(): string {
  return getAgentPath("settings.json");
}

function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

function getGlobalCompactionPolicyPath(): string {
  return getAgentPath("compaction-policy.json");
}

function getCustomCompactionExtensionPath(): string {
  return getAgentPath("extensions", "pi-custom-compaction");
}

function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    merged[key] = isRecord(baseValue) && isRecord(overrideValue)
      ? mergeSettings(baseValue, overrideValue)
      : overrideValue;
  }

  return merged;
}

function readSettingsFile(settingsPath: string): Record<string, unknown> {
  try {
    if (!existsSync(settingsPath)) {
      return {};
    }

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[pi-power-user] Ignoring non-object settings at ${settingsPath}`);
      return {};
    }

    return parsed;
  } catch (error) {
    // Settings are user-edited input. Log and keep the extension running with defaults
    // instead of crashing the UI during startup.
    console.debug(`[pi-power-user] Failed to read settings from ${settingsPath}:`, error);
    return {};
  }
}

function readWritableSettingsFile(settingsPath: string): Record<string, unknown> | null {
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[pi-power-user] Refusing to write settings to non-object file at ${settingsPath}`);
      return null;
    }

    return parsed;
  } catch (error) {
    // Do not overwrite malformed user settings with partial data. Surface the failure
    // through the command handler so the user can fix the file intentionally.
    console.debug(`[pi-power-user] Failed to parse settings at ${settingsPath}:`, error);
    return null;
  }
}

function readCompactionPolicyEnabled(configPath: string): boolean | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!isRecord(parsed) || typeof parsed.enabled !== "boolean") return false;
    return parsed.enabled;
  } catch (error) {
    console.debug(`[pi-power-user] Failed to read compaction policy from ${configPath}:`, error);
    return false;
  }
}

function detectCustomCompactionEnabled(cwd: string): boolean {
  if (!existsSync(getCustomCompactionExtensionPath())) return false;

  const projectSetting = readCompactionPolicyEnabled(join(cwd, ".pi", "compaction-policy.json"));
  if (projectSetting !== undefined) return projectSetting;

  return readCompactionPolicyEnabled(getGlobalCompactionPolicyPath()) ?? false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStashHistoryPath(): string {
  return getAgentPath("pi-power-user", "stash-history.json");
}

function getSessionsPath(): string {
  return getAgentPath("sessions");
}

function getProjectSessionsPath(cwd: string): string {
  const projectKey = cwd
    .replace(/^[/\\]+|[/\\]+$/g, "")
    .replace(/[\\/]+/g, "-");

  return join(getSessionsPath(), `--${projectKey}--`);
}

function getPromptHistoryText(content: unknown): string {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    parts.push(block.text);
  }

  return parts.join("\n").replace(/\s+/g, " ").trim();
}

function readFileTail(filePath: string, size: number, maxBytes: number): string {
  const bytesToRead = Math.min(size, maxBytes);
  if (bytesToRead === 0) {
    return "";
  }

  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, size - bytesToRead);
    const text = buffer.toString("utf8", 0, bytesRead);
    if (size <= bytesToRead) {
      return text;
    }

    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  } finally {
    closeSync(fd);
  }
}

function readRecentProjectPrompts(cwd: string, limit: number): string[] {
  const sessionsPath = getProjectSessionsPath(cwd);
  if (!existsSync(sessionsPath)) {
    return [];
  }

  const files = readdirSync(sessionsPath)
    .filter((fileName) => fileName.endsWith(".jsonl"))
    .map((fileName) => {
      const filePath = join(sessionsPath, fileName);
      const stats = statSync(filePath);
      return { fileName, filePath, mtimeMs: stats.mtimeMs, size: stats.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.fileName.localeCompare(a.fileName))
    .slice(0, PROJECT_PROMPT_HISTORY_FILE_LIMIT);

  const prompts: string[] = [];
  const seen = new Set<string>();
  let remainingBytes = PROJECT_PROMPT_HISTORY_MAX_BYTES;

  for (const file of files) {
    if (remainingBytes <= 0) {
      break;
    }

    const bytesToRead = Math.min(file.size, PROJECT_PROMPT_HISTORY_FILE_MAX_BYTES, remainingBytes);
    remainingBytes -= bytesToRead;
    const lines = readFileTail(file.filePath, file.size, bytesToRead).split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"type":"message"') || !line.includes('"role":"user"')) {
        continue;
      }

      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse session file ${file.filePath}: ${message}`, { cause: error });
      }

      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") {
        continue;
      }

      const text = getPromptHistoryText(entry.message.content);
      if (!hasNonWhitespaceText(text)) {
        continue;
      }

      if (seen.has(text)) {
        continue;
      }

      seen.add(text);
      prompts.push(text);
      if (prompts.length >= limit) {
        return prompts;
      }
    }
  }

  return prompts;
}

function normalizeStashHistoryEntries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const history: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    if (!hasNonWhitespaceText(entry)) {
      continue;
    }

    if (history[history.length - 1] === entry) {
      continue;
    }

    history.push(entry);
    if (history.length >= STASH_HISTORY_LIMIT) {
      break;
    }
  }

  return history;
}

function readPersistedStashHistory(): string[] {
  const stashHistoryPath = getStashHistoryPath();

  try {
    if (!existsSync(stashHistoryPath)) {
      return [];
    }

    const parsed = JSON.parse(readFileSync(stashHistoryPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[pi-power-user] Ignoring invalid stash history at ${stashHistoryPath}`);
      return [];
    }

    return normalizeStashHistoryEntries(parsed.history);
  } catch (error) {
    console.debug(`[pi-power-user] Failed to read stash history from ${stashHistoryPath}:`, error);
    return [];
  }
}

function persistStashHistory(history: string[]): void {
  const stashHistoryPath = getStashHistoryPath();
  const payload = {
    version: 1,
    history: history.slice(0, STASH_HISTORY_LIMIT),
  };

  try {
    mkdirSync(dirname(stashHistoryPath), { recursive: true });
    writeFileSync(stashHistoryPath, JSON.stringify(payload, null, 2) + "\n");
  } catch (error) {
    console.debug(`[pi-power-user] Failed to persist stash history to ${stashHistoryPath}:`, error);
  }
}

function readSettings(cwd: string = process.cwd()): Record<string, unknown> {
  return mergeSettings(readSettingsFile(getSettingsPath()), readSettingsFile(getProjectSettingsPath(cwd)));
}

function writePowerlineSetting(cwd: string, update: (existingPowerlineSetting: unknown) => unknown): boolean {
  const globalSettingsPath = getSettingsPath();
  const projectSettingsPath = getProjectSettingsPath(cwd);
  const globalSettings = readWritableSettingsFile(globalSettingsPath);
  const projectSettings = readWritableSettingsFile(projectSettingsPath);

  if (globalSettings === null || projectSettings === null) {
    return false;
  }

  const writeToProject = Object.prototype.hasOwnProperty.call(projectSettings, "powerline");
  const settingsPath = writeToProject ? projectSettingsPath : globalSettingsPath;
  const settings = writeToProject ? projectSettings : globalSettings;

  settings.powerline = update(settings.powerline);

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return true;
  } catch (error) {
    console.debug(`[pi-power-user] Failed to persist powerline setting to ${settingsPath}:`, error);
    return false;
  }
}

function writePowerlinePresetSetting(preset: StatusLinePreset, cwd: string = process.cwd()): boolean {
  return writePowerlineSetting(cwd, (existingPowerlineSetting) => (
    nextPowerlineSettingWithPreset(existingPowerlineSetting, preset)
  ));
}

function writePowerlineOptionSetting(
  cwd: string,
  updates: Partial<Pick<PowerlineConfig, "welcome" | "stashSharpSShortcut" | "placement">>,
  currentPreset: StatusLinePreset,
): boolean {
  return writePowerlineSetting(cwd, (existingPowerlineSetting) => (
    nextPowerlineSettingWithOptions(existingPowerlineSetting, updates, currentPreset)
  ));
}

const PRESET_NAMES = Object.keys(PRESETS) as StatusLinePreset[];

function isValidPreset(value: unknown): value is StatusLinePreset {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PRESETS, value);
}

function normalizePreset(value: unknown): StatusLinePreset | null {
  if (typeof value !== "string") {
    return null;
  }

  const preset = value.trim().toLowerCase();
  return isValidPreset(preset) ? preset : null;
}

function hasNonWhitespaceText(text: string): boolean {
  return text.trim().length > 0;
}

function getCurrentEditorText(ctx: any, editor: any): string {
  const editorText = editor?.getExpandedText?.();
  if (typeof editorText === "string" && editorText.length > 0) return editorText;
  return ctx.ui.getEditorText?.() ?? editorText ?? "";
}

function buildStashPreview(text: string, maxWidth: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "(empty)";
  return truncateToWidth(compact, maxWidth, "…");
}

function pushStashHistory(history: string[], text: string): boolean {
  if (!hasNonWhitespaceText(text)) return false;
  if (history[0] === text) return false;

  history.unshift(text);
  if (history.length > STASH_HISTORY_LIMIT) {
    history.length = STASH_HISTORY_LIMIT;
  }

  return true;
}

function normalizeShortcut(value: string): string {
  const parts = value.trim().toLowerCase().split("+");
  if (parts.length <= 1) return parts[0] ?? "";

  const modifierRank = new Map<string, number>(SHORTCUT_MODIFIER_ORDER.map((modifier, index) => [modifier, index]));
  const modifiers = parts.slice(0, -1).sort((a, b) => (modifierRank.get(a) ?? 99) - (modifierRank.get(b) ?? 99));
  return [...modifiers, parts[parts.length - 1]].join("+");
}

function formatShortcutLabel(shortcut: ShortcutBinding): string | null {
  return shortcut?.split("+").map((part) => part.toLowerCase() === "super" ? "cmd" : part).join("+") ?? null;
}

const POWERLINE_SHORTCUT_HELP: ReadonlyArray<{ key: PowerlineShortcutKey; label: string }> = [
  { key: "showShortcuts", label: "Show Powerline shortcuts" },
  { key: "stashHistory", label: "Open prompt history" },
  { key: "copyEditor", label: "Copy editor text" },
  { key: "cutEditor", label: "Cut editor text" },
  { key: "reply", label: "Quote a previous message" },
  { key: "editorStart", label: "Move editor to start" },
  { key: "editorEnd", label: "Move editor to end" },
];

export type PowerlineShortcutHelpKey = PowerlineShortcutKey | "stash" | "bashToggle";

export interface PowerlineShortcutHelpEntry {
  key: PowerlineShortcutHelpKey;
  label: string;
  shortcut: string;
}

export function getPowerlineShortcutHelpEntries(
  shortcuts: PowerlineShortcuts,
  bashModeToggleShortcut: ShortcutBinding,
): PowerlineShortcutHelpEntry[] {
  const entries: PowerlineShortcutHelpEntry[] = [
    { key: "stash", label: "Stash or restore editor", shortcut: "alt+s" },
  ];

  const bashToggleLabel = formatShortcutLabel(bashModeToggleShortcut);
  if (bashToggleLabel) {
    entries.push({ key: "bashToggle", label: "Toggle bash mode", shortcut: bashToggleLabel });
  }

  for (const { key, label } of POWERLINE_SHORTCUT_HELP) {
    const shortcut = formatShortcutLabel(shortcuts[key]);
    if (shortcut) {
      entries.push({ key, label, shortcut });
    }
  }

  return entries;
}

export interface ShortcutPaletteEntry {
  id: string;
  label: string;
  shortcut: string;
  runnable: boolean;
}

const SESSION_PICKER_KEYBINDING_IDS = new Set([
  "app.session.togglePath",
  "app.session.toggleSort",
  "app.session.toggleNamedFilter",
  "app.session.rename",
  "app.session.delete",
  "app.session.deleteNoninvasive",
]);

const PI_PALETTE_RUN_EXCLUDED = new Set(["app.interrupt", "app.exit", "app.clear"]);

// Bindings handled inside pi's modal selectors. Their handlers are private to
// components that only exist while the modal is open and has focus — so they can
// never be run from the palette, and those UIs render their own key hints anyway.
export function isModalScopedKeybinding(id: string): boolean {
  return id.startsWith("app.tree.")
    || id.startsWith("app.models.")
    || id.startsWith("tui.select.")
    || SESSION_PICKER_KEYBINDING_IDS.has(id);
}

export function piShortcutGroupPrefix(id: string): string {
  if (id.startsWith("tui.select.")) return "Lists: ";
  if (id.startsWith("tui.")) return "Editor: ";
  if (id.startsWith("app.tree.")) return "Tree view: ";
  if (id.startsWith("app.models.")) return "Model selector: ";
  return SESSION_PICKER_KEYBINDING_IDS.has(id) ? "Session picker: " : "";
}

export interface PiKeybindingDefinition {
  keys: string[];
  description?: string;
}

export function collectPiKeybindingDefinitions(keybindings: any): Record<string, PiKeybindingDefinition> {
  if (
    typeof keybindings?.getResolvedBindings !== "function"
    || typeof keybindings?.getDefinition !== "function"
    || typeof keybindings?.getKeys !== "function"
  ) {
    return {};
  }

  const definitions: Record<string, PiKeybindingDefinition> = {};
  for (const id of Object.keys(keybindings.getResolvedBindings())) {
    let description: string | undefined;
    try {
      description = keybindings.getDefinition(id)?.description;
    } catch {
      description = undefined;
    }

    let keys: string[] = [];
    try {
      const resolved = keybindings.getKeys(id);
      keys = Array.isArray(resolved) ? resolved : [];
    } catch {
      keys = [];
    }

    definitions[id] = { keys, description };
  }

  return definitions;
}

export function buildShortcutPaletteEntries(options: {
  powerlineEntries: PowerlineShortcutHelpEntry[];
  piKeybindings: Record<string, PiKeybindingDefinition>;
  isPiActionRunnable: (id: string) => boolean;
}): ShortcutPaletteEntry[] {
  const entries: ShortcutPaletteEntry[] = options.powerlineEntries.map((entry) => ({
    id: `powerline:${entry.key}`,
    label: `Powerline: ${entry.label}`,
    shortcut: entry.shortcut,
    runnable: true,
  }));

  const referenceEntries: ShortcutPaletteEntry[] = [];
  for (const [id, definition] of Object.entries(options.piKeybindings)) {
    const runnable = options.isPiActionRunnable(id);
    if (!runnable && isModalScopedKeybinding(id)) {
      continue;
    }

    const entry: ShortcutPaletteEntry = {
      id: `pi:${id}`,
      label: `${piShortcutGroupPrefix(id)}${definition.description ?? id}`,
      shortcut: definition.keys.filter(Boolean).join(", "),
      runnable,
    };
    (entry.runnable ? entries : referenceEntries).push(entry);
  }

  return [...entries, ...referenceEntries];
}

export function shortcutPaletteItemDescription(entry: ShortcutPaletteEntry): string | undefined {
  if (entry.runnable) return entry.shortcut || undefined;
  return entry.shortcut ? `${entry.shortcut} · reference` : "reference";
}

export function isShortcutPaletteQueryInput(data: string): boolean {
  if (!data) return false;

  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function reservedShortcuts(): Set<string> {
  const shortcuts = new Set<string>([
    ...EXTRA_RESERVED_SHORTCUTS,
    ...APP_RESERVED_SHORTCUTS,
  ].map(normalizeShortcut));

  for (const definition of Object.values(TUI_KEYBINDINGS)) {
    const defaultKeys = definition.defaultKeys;
    const keys = defaultKeys === undefined ? [] : Array.isArray(defaultKeys) ? defaultKeys : [defaultKeys];
    for (const key of keys) {
      shortcuts.add(normalizeShortcut(key));
    }
  }

  return shortcuts;
}

function isValidShortcutKeyPart(keyPart: string): boolean {
  const lowerKeyPart = keyPart.toLowerCase();

  if (/^[a-z0-9]$/i.test(keyPart)) return true;
  if (/^f([1-9]|1[0-2])$/i.test(keyPart)) return true;
  if (SHORTCUT_NAMED_KEYS.has(lowerKeyPart)) return true;

  return SHORTCUT_SYMBOL_KEYS.has(keyPart);
}

function parseShortcutOverride(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  const parts = trimmed.split("+");
  if (parts.some((part) => part.length === 0)) {
    return null;
  }

  const modifierParts = parts.slice(0, -1).map((part) => {
    const modifier = part.toLowerCase();
    return modifier === "cmd" || modifier === "command" ? "super" : modifier;
  });
  if (new Set(modifierParts).size !== modifierParts.length) {
    return null;
  }

  for (const modifier of modifierParts) {
    if (!SHORTCUT_MODIFIERS.has(modifier)) {
      return null;
    }
  }

  const keyPart = parts[parts.length - 1];
  if (!isValidShortcutKeyPart(keyPart)) {
    return null;
  }

  const normalizedKey = SHORTCUT_SYMBOL_KEYS.has(keyPart) ? keyPart : keyPart.toLowerCase();
  const normalizedShortcut = normalizeShortcut([...modifierParts, normalizedKey].join("+"));
  if (shortcutUsesSuper(normalizedShortcut) && !isSupportedSuperShortcut(normalizedShortcut)) {
    return null;
  }

  return normalizedShortcut;
}

function shortcutUsageKey(shortcut: string): string {
  return shortcutConflictKey(normalizeShortcut(shortcut));
}

function parseShortcutSetting(value: unknown): ShortcutBinding | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return parseShortcutOverride(value) ?? undefined;
}

function findShortcutReplacement(key: PowerlineShortcutKey, used: Set<string>): string | null {
  const preferred = DEFAULT_SHORTCUTS[key];
  if (preferred && !used.has(shortcutUsageKey(preferred))) {
    return preferred;
  }
  return null;
}

function shortcutBelongsToOtherDefault(key: PowerlineShortcutKey, shortcut: string): boolean {
  const usageKey = shortcutUsageKey(shortcut);
  return SHORTCUT_KEYS.some((shortcutKey) => {
    const defaultShortcut = DEFAULT_SHORTCUTS[shortcutKey];
    return shortcutKey !== key && defaultShortcut !== null && shortcutUsageKey(defaultShortcut) === usageKey;
  });
}

function bashToggleShortcutReservation(settings: Record<string, unknown>): ShortcutBinding {
  const raw = isRecord(settings.bashMode) ? settings.bashMode : {};
  if (!Object.prototype.hasOwnProperty.call(raw, "toggleShortcut")) {
    return DEFAULT_BASH_MODE_SETTINGS.toggleShortcut;
  }

  const parsed = parseShortcutSetting(raw.toggleShortcut);
  return parsed === undefined ? DEFAULT_BASH_MODE_SETTINGS.toggleShortcut : parsed;
}

export function resolveShortcutConfig(settings: Record<string, unknown>): PowerlineShortcuts {
  const resolved: PowerlineShortcuts = { ...DEFAULT_SHORTCUTS };
  const shortcutSettings = settings.powerlineShortcuts;

  if (isRecord(shortcutSettings)) {
    for (const key of SHORTCUT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(shortcutSettings, key)) {
        continue;
      }

      const override = parseShortcutSetting(shortcutSettings[key]);
      if (override !== undefined) {
        resolved[key] = override;
      }
    }
  }

  const used = new Set(Array.from(reservedShortcuts(), shortcutUsageKey));
  const reservedBashToggle = bashToggleShortcutReservation(settings);
  if (reservedBashToggle) {
    used.add(shortcutUsageKey(reservedBashToggle));
  }

  for (const key of SHORTCUT_KEYS) {
    const configured = resolved[key];
    if (configured === null) {
      continue;
    }

    const configuredUsageKey = shortcutUsageKey(configured);

    if (!used.has(configuredUsageKey) && !shortcutBelongsToOtherDefault(key, configured)) {
      used.add(configuredUsageKey);
      continue;
    }

    const replacement = findShortcutReplacement(key, used);
    if (!replacement) {
      console.debug(`[pi-power-user] Shortcut conflict for ${key}: "${configured}" is already in use`);
      resolved[key] = null;
      continue;
    }

    console.debug(
      `[pi-power-user] Shortcut conflict for ${key}: "${configured}" replaced with "${replacement}"`,
    );

    resolved[key] = replacement;
    used.add(shortcutUsageKey(replacement));
  }

  return resolved;
}

export function parseBashModeSettings(settings: Record<string, unknown>, powerlineShortcuts?: PowerlineShortcuts): BashModeSettings {
  const raw = isRecord(settings.bashMode) ? settings.bashMode : {};
  const used = new Set(Array.from(reservedShortcuts(), shortcutUsageKey));
  if (powerlineShortcuts) {
    for (const shortcut of Object.values(powerlineShortcuts)) {
      if (shortcut) {
        used.add(shortcutUsageKey(shortcut));
      }
    }
  }

  const configuredToggleShortcut = Object.prototype.hasOwnProperty.call(raw, "toggleShortcut")
    ? parseShortcutSetting(raw.toggleShortcut)
    : undefined;
  const fallbackToggleShortcut = used.has(shortcutUsageKey(DEFAULT_BASH_MODE_SETTINGS.toggleShortcut))
    ? null
    : DEFAULT_BASH_MODE_SETTINGS.toggleShortcut;
  const toggleShortcut = configuredToggleShortcut === null
    ? null
    : configuredToggleShortcut
      && !used.has(shortcutUsageKey(configuredToggleShortcut))
      ? configuredToggleShortcut
      : fallbackToggleShortcut;

  if (configuredToggleShortcut && toggleShortcut !== configuredToggleShortcut) {
    console.debug(
      `[pi-power-user] Bash mode shortcut conflict: "${configuredToggleShortcut}" replaced with "${toggleShortcut ?? "disabled"}"`,
    );
  }
  const completions = typeof raw.completions === "boolean"
    ? raw.completions
    : DEFAULT_BASH_MODE_SETTINGS.completions;
  const transcriptMaxLines = typeof raw.transcriptMaxLines === "number" && Number.isFinite(raw.transcriptMaxLines)
    ? Math.max(100, Math.floor(raw.transcriptMaxLines))
    : DEFAULT_BASH_MODE_SETTINGS.transcriptMaxLines;
  const transcriptMaxBytes = typeof raw.transcriptMaxBytes === "number" && Number.isFinite(raw.transcriptMaxBytes)
    ? Math.max(16 * 1024, Math.floor(raw.transcriptMaxBytes))
    : DEFAULT_BASH_MODE_SETTINGS.transcriptMaxBytes;

  return {
    toggleShortcut,
    completions,
    transcriptMaxLines,
    transcriptMaxBytes,
  };
}

const FAST_EDITOR_RENDER_LINE_THRESHOLD = 80;
const FAST_EDITOR_RENDER_COLUMN_THRESHOLD = 1200;

interface FastEditorState {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

interface FastEditorVisualLine {
  text: string;
  cursorCol?: number;
}

function readFastEditorState(editor: unknown): FastEditorState | null {
  const state = Reflect.get(editor as object, "state");
  if (!isRecord(state) || !Array.isArray(state.lines)) return null;
  if (typeof state.cursorLine !== "number" || typeof state.cursorCol !== "number") return null;

  const lines = state.lines as string[];
  const cursorLine = Math.max(0, Math.min(lines.length - 1, Math.floor(state.cursorLine)));
  const cursorText = lines[cursorLine] ?? "";
  if (typeof cursorText !== "string") return null;
  const cursorCol = Math.max(0, Math.min(cursorText.length, Math.floor(state.cursorCol)));
  return { lines, cursorLine, cursorCol };
}

function fastChunkCount(line: string, width: number): number {
  return Math.max(1, Math.ceil(Math.max(1, line.length) / width));
}

function fastChunk(line: string, width: number, chunkIndex: number): { text: string; startCol: number } {
  const startCol = chunkIndex * width;
  return { text: line.slice(startCol, startCol + width), startCol };
}

function isFastRenderableText(text: string): boolean {
  return /^[\x20-\x7E]*$/.test(text);
}

function pushTrailingChunks(target: FastEditorVisualLine[], line: string, width: number, maxCount: number): void {
  const count = fastChunkCount(line, width);
  const start = Math.max(0, count - maxCount);
  for (let index = start; index < count; index++) {
    target.push({ text: fastChunk(line, width, index).text });
  }
}

function collectFastEditorVisualLines(state: FastEditorState, layoutWidth: number, maxVisibleLines: number): {
  lines: FastEditorVisualLine[];
  hasBefore: boolean;
  hasAfter: boolean;
} {
  const cursorText = state.lines[state.cursorLine] ?? "";
  const cursorChunkIndex = Math.floor(state.cursorCol / layoutWidth);
  const cursorChunkCount = Math.max(fastChunkCount(cursorText, layoutWidth), cursorChunkIndex + 1);
  const firstCursorChunk = Math.max(0, cursorChunkIndex - maxVisibleLines + 1);

  const visualLines: FastEditorVisualLine[] = [];
  for (let lineIndex = state.cursorLine - 1; lineIndex >= 0 && visualLines.length < maxVisibleLines - 1; lineIndex--) {
    const chunks: FastEditorVisualLine[] = [];
    pushTrailingChunks(chunks, state.lines[lineIndex] ?? "", layoutWidth, maxVisibleLines - 1 - visualLines.length);
    visualLines.unshift(...chunks);
  }

  for (let chunkIndex = firstCursorChunk; chunkIndex < cursorChunkIndex && visualLines.length < maxVisibleLines - 1; chunkIndex++) {
    visualLines.push({ text: fastChunk(cursorText, layoutWidth, chunkIndex).text });
  }

  const cursorChunk = fastChunk(cursorText, layoutWidth, cursorChunkIndex);
  visualLines.push({
    text: cursorChunk.text,
    cursorCol: state.cursorCol - cursorChunk.startCol,
  });

  for (let chunkIndex = cursorChunkIndex + 1; chunkIndex < cursorChunkCount && visualLines.length < maxVisibleLines; chunkIndex++) {
    visualLines.push({ text: fastChunk(cursorText, layoutWidth, chunkIndex).text });
  }

  for (let lineIndex = state.cursorLine + 1; lineIndex < state.lines.length && visualLines.length < maxVisibleLines; lineIndex++) {
    const line = state.lines[lineIndex] ?? "";
    const count = fastChunkCount(line, layoutWidth);
    for (let chunkIndex = 0; chunkIndex < count && visualLines.length < maxVisibleLines; chunkIndex++) {
      visualLines.push({ text: fastChunk(line, layoutWidth, chunkIndex).text });
    }
  }

  return {
    lines: visualLines.slice(-maxVisibleLines),
    hasBefore: state.cursorLine > 0 || firstCursorChunk > 0,
    hasAfter: state.cursorLine < state.lines.length - 1 || cursorChunkIndex < cursorChunkCount - 1,
  };
}

function renderFastCursorLine(line: string, cursorCol: number, focused: boolean): string {
  const before = line.slice(0, cursorCol);
  const target = line[cursorCol];
  const marker = focused ? CURSOR_MARKER : "";
  if (target) {
    return `${before}${marker}\x1b[7m${target}\x1b[0m${line.slice(cursorCol + target.length)}`;
  }
  return `${before}${marker}\x1b[7m \x1b[0m`;
}

function padToWidth(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

export function colorEditorBorder(editor: unknown, text: string): string {
  const borderColor = editor && typeof editor === "object"
    ? Reflect.get(editor, "borderColor")
    : undefined;
  return typeof borderColor === "function"
    ? borderColor.call(editor, text)
    : `${getFgAnsiCode("sep")}${text}${ansi.reset}`;
}

export function renderFastPowerlineEditor(
  editor: unknown,
  width: number,
  options: { bashModeActive: boolean; completionsEnabled: boolean },
): string[] | null {
  if (width < 10 || options.completionsEnabled) return null;
  if (Reflect.get(editor as object, "isInPaste") === true || Reflect.get(editor as object, "jumpMode") != null) return null;
  if (Reflect.get(editor as object, "autocompleteState") != null) return null;

  const isShowingAutocomplete = Reflect.get(editor as object, "isShowingAutocomplete");
  if (typeof isShowingAutocomplete === "function" && isShowingAutocomplete.call(editor)) return null;

  const state = readFastEditorState(editor);
  if (!state) return null;

  const cursorText = state.lines[state.cursorLine] ?? "";
  if (state.lines.length < FAST_EDITOR_RENDER_LINE_THRESHOLD && cursorText.length < FAST_EDITOR_RENDER_COLUMN_THRESHOLD) {
    return null;
  }

  const terminalRows = Reflect.get(Reflect.get(editor as object, "tui") ?? {}, "terminal")?.rows;
  const maxVisibleLines = Math.max(5, Math.floor((typeof terminalRows === "number" ? terminalRows : 24) * 0.3));
  const innerWidth = Math.max(1, width - 3);
  const layoutWidth = Math.max(1, innerWidth - 1);
  const viewport = collectFastEditorVisualLines(state, layoutWidth, maxVisibleLines);
  if (viewport.lines.some((line) => !isFastRenderableText(line.text))) return null;

  Reflect.set(editor as object, "lastWidth", layoutWidth);

  const border = (marker: "↑" | "↓" | "─") => {
    const text = marker === "─" ? "─".repeat(width - 2) : `${marker}${"─".repeat(Math.max(0, width - 3))}`;
    return ` ${colorEditorBorder(editor, text)}`;
  };
  const promptGlyph = options.bashModeActive ? "$" : ">";
  const prompt = `${ansi.getFgAnsi(200, 200, 200)}${promptGlyph}${ansi.reset}`;
  const promptPrefix = ` ${prompt} `;
  const contPrefix = "   ";

  const lines = [border(viewport.hasBefore ? "↑" : "─")];
  for (let index = 0; index < viewport.lines.length; index++) {
    const visual = viewport.lines[index]!;
    const content = visual.cursorCol === undefined
      ? visual.text
      : renderFastCursorLine(visual.text, visual.cursorCol, Reflect.get(editor as object, "focused") === true);
    lines.push(`${index === 0 ? promptPrefix : contPrefix}${padToWidth(content, innerWidth)}`);
  }
  lines.push(border(viewport.hasAfter ? "↓" : "─"));
  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Status Line Builder
// ═══════════════════════════════════════════════════════════════════════════

/** Render a single segment and return its content with width */
function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

/** Build content string from pre-rendered parts */
function buildContentFromParts(
  parts: string[],
  separatorStyle: StatusLineSeparatorStyle,
): string {
  if (parts.length === 0) return "";
  const separatorDef = getSeparator(separatorStyle);
  const sepAnsi = getFgAnsiCode("sep");
  const sep = separatorDef.left;
  return " " + parts.join(` ${sepAnsi}${sep}${ansi.reset} `) + ansi.reset + " ";
}

type ResponsiveLayout = { topContent: string; secondaryLines: string[] };

/**
 * Responsive segment layout - fits segments into top bar, overflows to secondary row.
 * When terminal is wide enough, secondary segments move up to top bar.
 * When narrow, top bar segments overflow down to secondary row.
 * With `secondaryOverflow: "wrap"`, secondary overflow continues on additional rows.
 */
function computeResponsiveLayout(
  ctx: SegmentContext,
  presetDef: ReturnType<typeof getPreset>,
  allSegmentIds: StatusLineSegmentId[],
  availableWidth: number
): ResponsiveLayout {
  const separatorStyle = config.separator ?? presetDef.separator;
  const separatorDef = getSeparator(separatorStyle);
  const sepWidth = visibleWidth(separatorDef.left) + 2; // separator + spaces around it

  // Render all segments and get their widths
  const renderedSegments: { content: string; width: number }[] = [];
  for (const segId of allSegmentIds) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) {
      renderedSegments.push({ content, width });
    }
  }

  if (renderedSegments.length === 0) {
    return { topContent: "", secondaryLines: [] };
  }

  // Calculate how many segments fit in top bar
  // Account for: leading space (1) + trailing space (1) = 2 chars overhead
  const baseOverhead = 2;
  let currentWidth = baseOverhead;
  let topSegments: string[] = [];
  let overflowSegments: { content: string; width: number }[] = [];
  let overflow = false;

  for (const seg of renderedSegments) {
    const neededWidth = seg.width + (topSegments.length > 0 ? sepWidth : 0);

    if (!overflow && currentWidth + neededWidth <= availableWidth) {
      topSegments.push(seg.content);
      currentWidth += neededWidth;
    } else {
      overflow = true;
      overflowSegments.push(seg);
    }
  }

  // Fit overflow segments into secondary rows (same width constraint).
  // Drop mode stops at the first non-fitting segment to preserve ordering.
  // Wrap mode starts a new row instead, skipping segments too wide for any row.
  const wrap = config.secondaryOverflow === "wrap";
  const secondaryRows: string[][] = [[]];
  let secondaryWidth = baseOverhead;

  for (const seg of overflowSegments) {
    let row = secondaryRows[secondaryRows.length - 1]!;
    let neededWidth = seg.width + (row.length > 0 ? sepWidth : 0);
    if (secondaryWidth + neededWidth > availableWidth) {
      if (!wrap) break;
      if (baseOverhead + seg.width > availableWidth) continue;
      row = [];
      secondaryRows.push(row);
      secondaryWidth = baseOverhead;
      neededWidth = seg.width;
    }
    row.push(seg.content);
    secondaryWidth += neededWidth;
  }

  return {
    topContent: buildContentFromParts(topSegments, separatorStyle),
    secondaryLines: secondaryRows
      .filter((row) => row.length > 0)
      .map((row) => buildContentFromParts(row, separatorStyle)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

function warnInvalidSegmentSettings(ctx: any): void {
  if (config.invalidDisabledSegments.length > 0) {
    const invalid = config.invalidDisabledSegments.map((id) => JSON.stringify(id)).join(", ");
    const message = `Ignoring unknown powerline disabled segment${config.invalidDisabledSegments.length === 1 ? "" : "s"}: ${invalid}`;
    console.warn(`[pi-power-user] ${message}`);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
  }

  if (config.invalidLayoutSegments.length > 0) {
    const invalid = config.invalidLayoutSegments.map((id) => JSON.stringify(id)).join(", ");
    const message = `Ignoring unknown powerline layout segment${config.invalidLayoutSegments.length === 1 ? "" : "s"}: ${invalid}`;
    console.warn(`[pi-power-user] ${message}`);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
  }

  if (config.invalidPlacement !== null) {
    const message = `Ignoring invalid powerline placement: ${JSON.stringify(config.invalidPlacement)}`;
    console.warn(`[pi-power-user] ${message}`);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
  }

  if (config.invalidSecondaryOverflow !== null) {
    const message = `Ignoring invalid powerline secondaryOverflow: ${JSON.stringify(config.invalidSecondaryOverflow)}`;
    console.warn(`[pi-power-user] ${message}`);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
  }
}

export default function powerlineFooter(pi: ExtensionAPI) {
  const startupSettings = readSettings();
  config = parsePowerlineConfig(startupSettings.powerline, PRESET_NAMES);
  let resolvedShortcuts = resolveShortcutConfig(startupSettings);
  let bashModeSettings = parseBashModeSettings(startupSettings, resolvedShortcuts);

  let enabled = true;
  let sessionStartTime = Date.now();
  let sessionGeneration = 0;
  let currentCtx: any = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let footerDataCwd: string | null = null;
  let getThinkingLevelFn: (() => string) | null = null;
  let currentThinkingLevel: string | null = null;
  let liveAssistantUsage: SessionAssistantUsage | null = null;
  let subscriptionUsageByProvider = new Map<SupportedSubscriptionProvider, CachedSubscriptionUsage>();
  let subscriptionUsageInflight = new Map<SupportedSubscriptionProvider, Promise<void>>();
  let approximateContextUsage: CoreContextUsage | null = null;
  let isStreaming = false;
  let tuiRef: any = null;
  let restoreFooterStatusRepaintHook: (() => void) | null = null;
  let stashShortcutInputUnsubscribe: (() => void) | null = null;
  let dismissWelcomeOverlay: (() => void) | null = null;
  let welcomeHeaderActive = false;
  let welcomeRequest: AbortController | null = null;
  let welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastUserPrompt = "";
  let showLastPrompt = true;
  let lastPromptRenderCache: {
    source: string;
    compact: string;
    width: number;
    color: string;
    lines: string[];
  } | null = null;
  let stashedEditorText: string | null = null;
  let stashedPromptHistory: string[] = readPersistedStashHistory();
  let currentEditor: any = null;
  let bashModeActive = false;
  let bashTranscript = new BashTranscriptStore(bashModeSettings);
  let bashCompletionEngine = new BashCompletionEngine();
  let shellSession: ManagedShellSession | null = null;
  let pendingSend: {
    text: string;
    submit: (text: string) => unknown;
    deadline: number;
    timer: ReturnType<typeof setTimeout>;
    ticker: ReturnType<typeof setInterval>;
  } | null = null;

  // Cache for the top and secondary powerline widgets.
  let lastLayoutWidth = 0;
  let lastLayoutResult: ResponsiveLayout | null = null;
  let lastLayoutTimestamp = 0;
  let layoutDirty = true;
  let forceNextLayoutRecompute = false;
  let lastEditorInputAt = 0;

  // Cache for token counting: avoid re-scanning the full session event list
  // on every render (250ms-1s cadence). Revalidates the trailing event's
  // stats signature so in-place streaming updates are not served stale.
  const sessionBranchCache = new SessionBranchCache();
  const tokenStatsCache = new SessionTokenStatsCache();
  const coreContextUsageCache = new CoreContextUsageCache();

  const getShellPath = () => process.env.SHELL || "/bin/sh";
  const getShellCwd = () => shellSession?.state.cwd ?? currentCtx?.cwd ?? process.cwd();
  const statusRenderScheduler = createRenderScheduler(() => {
    const msSinceInput = Date.now() - lastEditorInputAt;
    if (layoutDirty && !forceNextLayoutRecompute && msSinceInput < EDITOR_STATUS_DEFER_MS) {
      statusRenderScheduler.schedule(Math.max(0, EDITOR_STATUS_DEFER_MS - msSinceInput));
      return;
    }

    tuiRef?.requestRender();
  }, STATUS_RENDER_DEBOUNCE_MS);

  const resetLayoutCache = () => {
    lastLayoutResult = null;
    layoutDirty = true;
    sessionBranchCache.reset();
    tokenStatsCache.reset();
    coreContextUsageCache.reset();
  };

  const requestStatusRender = (delayMs?: number) => {
    layoutDirty = true;
    statusRenderScheduler.schedule(delayMs);
  };

  const requestImmediateStatusRender = (options: { deferDuringTyping?: boolean } = {}) => {
    layoutDirty = true;
    if (options.deferDuringTyping !== false && Date.now() - lastEditorInputAt < EDITOR_STATUS_DEFER_MS) {
      statusRenderScheduler.schedule();
      return;
    }

    forceNextLayoutRecompute = true;
    statusRenderScheduler.cancel();
    statusRenderScheduler.schedule(0);
  };

  const refreshSubscriptionUsage = (ctx: any, provider: SupportedSubscriptionProvider) => {
    const model = ctx?.model;
    if (!model || model.provider !== provider || !ctx?.modelRegistry?.getApiKeyAndHeaders) {
      return;
    }

    if (subscriptionUsageInflight.has(provider)) {
      return;
    }

    const refreshPromise = (async () => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth?.ok) {
        throw new Error(typeof auth?.error === "string" ? auth.error : "failed to resolve model auth");
      }

      const usage = await fetchProviderSubscriptionUsage(provider, auth.apiKey, auth.headers);
      subscriptionUsageByProvider.set(provider, { usage, fetchedAt: usage.fetchedAt });
    })()
      .catch((error: unknown) => {
        subscriptionUsageByProvider.set(provider, {
          usage: null,
          fetchedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        subscriptionUsageInflight.delete(provider);
        requestImmediateStatusRender({ deferDuringTyping: false });
      });

    subscriptionUsageInflight.set(provider, refreshPromise);
  };

  const ensureSubscriptionUsage = (ctx: any) => {
    const model = ctx?.model;
    const provider = getSupportedSubscriptionProvider(model);
    if (!provider || !isSubscriptionUsageEnabled(provider, ctx?.modelRegistry?.isUsingOAuth?.(model) ?? false)) {
      return;
    }

    const cached = subscriptionUsageByProvider.get(provider);
    const refreshMs = cached?.error ? SUBSCRIPTION_USAGE_RETRY_MS : SUBSCRIPTION_USAGE_REFRESH_MS;
    if (cached && Date.now() - cached.fetchedAt < refreshMs) {
      return;
    }

    refreshSubscriptionUsage(ctx, provider);
  };

  const installFooterStatusRepaintHook = (footerData: ReadonlyFooterDataProvider) => {
    restoreFooterStatusRepaintHook?.();
    restoreFooterStatusRepaintHook = null;

    const writableFooterData = footerData as ReadonlyFooterDataProvider & {
      setExtensionStatus?: (key: string, text: string | undefined) => void;
      clearExtensionStatuses?: () => void;
    };
    if (typeof writableFooterData.setExtensionStatus !== "function") return;

    const originalSetExtensionStatus = writableFooterData.setExtensionStatus;
    const originalClearExtensionStatuses = writableFooterData.clearExtensionStatuses;
    const setExtensionStatusAndRepaint = function setExtensionStatusAndRepaint(this: unknown, key: string, text: string | undefined) {
      originalSetExtensionStatus.call(this, key, text);
      requestImmediateStatusRender();
    };
    writableFooterData.setExtensionStatus = setExtensionStatusAndRepaint;

    let clearExtensionStatusesAndRepaint: (() => void) | null = null;
    if (typeof originalClearExtensionStatuses === "function") {
      clearExtensionStatusesAndRepaint = function clearExtensionStatusesAndRepaint(this: unknown) {
        originalClearExtensionStatuses.call(this);
        requestImmediateStatusRender();
      };
      writableFooterData.clearExtensionStatuses = clearExtensionStatusesAndRepaint;
    }

    restoreFooterStatusRepaintHook = () => {
      if (writableFooterData.setExtensionStatus === setExtensionStatusAndRepaint) {
        writableFooterData.setExtensionStatus = originalSetExtensionStatus;
      }
      if (clearExtensionStatusesAndRepaint && writableFooterData.clearExtensionStatuses === clearExtensionStatusesAndRepaint) {
        writableFooterData.clearExtensionStatuses = originalClearExtensionStatuses;
      }
    };
  };

  const getShellHistoryEntries = (prefix: string): string[] => {
    const project = matchHistoryEntries(
      readProjectHistory(currentCtx?.cwd ?? process.cwd()).map((entry) => entry.command),
      prefix,
      50,
    );
    const global = matchHistoryEntries(readGlobalShellHistory(getShellPath()), prefix, 50);
    return [...new Set([...project, ...global])];
  };

  const ensureShellSession = async (): Promise<ManagedShellSession> => {
    if (!shellSession) {
      shellSession = new ManagedShellSession(
        getShellPath(),
        currentCtx?.cwd ?? process.cwd(),
        bashTranscript,
        requestStatusRender,
        (command, cwd) => appendProjectHistory(currentCtx?.cwd ?? process.cwd(), command, cwd),
      );
    }
    await shellSession.ensureReady();
    return shellSession;
  };

  const runShellCommand = async (command: string, ctx: any): Promise<void> => {
    try {
      const session = await ensureShellSession();
      await session.runCommand(command);
      requestStatusRender();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to run shell command: ${message}`, "error");
    }
  };

  const setBashModeActive = async (value: boolean, ctx: any): Promise<void> => {
    if (value === bashModeActive) return;
    if (!value && shellSession?.state.running) {
      ctx.ui.notify("Wait for the current shell command to finish before leaving bash mode", "warning");
      return;
    }

    if (value) {
      try {
        const session = await ensureShellSession();
        bashModeActive = true;
        currentEditor?.dismissBashModeUi?.();
        currentEditor?.refreshGhostSuggestion?.();
        requestStatusRender();
        ctx.ui.notify(`Bash mode enabled (${session.state.shellName})`, "info");
      } catch (error) {
        shellSession?.dispose();
        shellSession = null;
        bashModeActive = false;
        requestStatusRender();
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to start shell session: ${message}`, "error");
      }
      return;
    }

    bashModeActive = value;
    currentEditor?.dismissBashModeUi?.();
    requestStatusRender();
    ctx.ui.notify("Bash mode disabled", "info");
  };

  function overlaySelectListTheme(theme: Theme) {
    return {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };
  }

  async function showSelectOverlay(
    ctx: any,
    title: string,
    hint: string,
    items: SelectItem[],
    maxVisible: number,
  ): Promise<SelectItem | null> {
    return ctx.ui.custom(
      (tui: any, theme: Theme, _keybindings: any, done: (result: SelectItem | null) => void) => {
        const selectList = new SelectList(items, maxVisible, overlaySelectListTheme(theme));
        const border = (text: string) => theme.fg("dim", text);
        const wrapRow = (text: string, innerWidth: number): string => {
          return `${border("│")}${truncateToWidth(text, innerWidth, "…", true)}${border("│")}`;
        };

        selectList.onSelect = (item) => done(item);
        selectList.onCancel = () => done(null);

        return {
          render: (width: number) => {
            const innerWidth = Math.max(1, width - 2);
            const lines: string[] = [];

            lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
            lines.push(wrapRow(theme.fg("accent", theme.bold(title)), innerWidth));
            lines.push(border(`├${"─".repeat(innerWidth)}┤`));

            for (const line of selectList.render(innerWidth)) {
              lines.push(wrapRow(line, innerWidth));
            }

            lines.push(border(`├${"─".repeat(innerWidth)}┤`));
            lines.push(wrapRow(theme.fg("dim", hint), innerWidth));
            lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

            return lines;
          },
          invalidate: () => selectList.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: () => ({
          verticalAlign: "center",
          horizontalAlign: "center",
        }),
      },
    );
  }

  function takePendingSend(): NonNullable<typeof pendingSend> | null {
    const pending = pendingSend;
    if (!pending) return null;
    pendingSend = null;
    clearTimeout(pending.timer);
    clearInterval(pending.ticker);
    tuiRef?.requestRender();
    return pending;
  }

  function sendPendingNow(): void {
    const pending = takePendingSend();
    if (!pending) return;
    void pending.submit(pending.text);
  }

  function restorePendingSend(): void {
    const pending = takePendingSend();
    if (!pending) return;
    // setText drops paste markers, so a draft typed during the countdown is kept in expanded form.
    const draft = currentEditor.getExpandedText();
    currentEditor.setText(draft.trim() ? `${pending.text}\n\n${draft}` : pending.text);
  }

  function submitWithDelay(text: string, submit: (text: string) => unknown): void {
    const trimmed = text.trim();
    if (!trimmed) {
      sendPendingNow();
      return;
    }
    if (config.sendDelayMs <= 0 || trimmed.startsWith("/") || trimmed.startsWith("!")) {
      void submit(text);
      return;
    }
    sendPendingNow();
    pendingSend = {
      text: trimmed,
      submit,
      deadline: Date.now() + config.sendDelayMs,
      timer: setTimeout(sendPendingNow, config.sendDelayMs),
      ticker: setInterval(() => tuiRef?.requestRender(), 1000),
    };
    tuiRef?.requestRender();
  }

  function isPiActionRunnable(id: string): boolean {
    if (PI_PALETTE_RUN_EXCLUDED.has(id)) return false;
    if (id === "app.clipboard.pasteImage") return typeof currentEditor?.onPasteImage === "function";

    const handlers = currentEditor?.actionHandlers;
    return handlers instanceof Map && typeof handlers.get(id) === "function";
  }

  async function showShortcutPalette(ctx: any): Promise<void> {
    const selected: ShortcutPaletteEntry | null = await ctx.ui.custom(
      (tui: any, theme: Theme, keybindings: any, done: (result: ShortcutPaletteEntry | null) => void) => {
        const entries = buildShortcutPaletteEntries({
          powerlineEntries: getPowerlineShortcutHelpEntries(resolvedShortcuts, bashModeSettings.toggleShortcut),
          piKeybindings: collectPiKeybindingDefinitions(keybindings),
          isPiActionRunnable,
        });
        const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

        let query = "";
        let selectList!: SelectList;

        const rebuildList = () => {
          const matched = query
            ? fuzzyFilter(entries, query, (entry) => `${entry.label} ${entry.shortcut}`)
            : entries;
          // Keep runnable commands ahead of reference-only entries, preserving fuzzy rank within each group.
          const filtered = [...matched.filter((entry) => entry.runnable), ...matched.filter((entry) => !entry.runnable)];
          const items: SelectItem[] = filtered.map((entry) => ({
            value: entry.id,
            label: entry.label,
            description: shortcutPaletteItemDescription(entry),
          }));
          selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 10), overlaySelectListTheme(theme));
          selectList.onSelect = (item) => done(entriesById.get(item.value) ?? null);
          selectList.onCancel = () => done(null);
        };
        rebuildList();

        const border = (text: string) => theme.fg("dim", text);
        const wrapRow = (text: string, innerWidth: number): string => {
          return `${border("│")}${truncateToWidth(text, innerWidth, "…", true)}${border("│")}`;
        };

        return {
          render: (width: number) => {
            const innerWidth = Math.max(1, width - 2);
            const lines: string[] = [];

            lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
            lines.push(wrapRow(theme.fg("accent", theme.bold("Shortcuts")), innerWidth));
            lines.push(wrapRow(`${theme.fg("accent", "❯ ")}${query}${theme.fg("dim", "█")}`, innerWidth));
            lines.push(border(`├${"─".repeat(innerWidth)}┤`));

            for (const line of selectList.render(innerWidth)) {
              lines.push(wrapRow(line, innerWidth));
            }

            lines.push(border(`├${"─".repeat(innerWidth)}┤`));
            lines.push(wrapRow(theme.fg("dim", "type to search • ↑↓ navigate • enter run • esc close"), innerWidth));
            lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

            return lines;
          },
          invalidate: () => selectList.invalidate(),
          handleInput: (data: string) => {
            if (isKeyRelease(data)) return;

            if (matchesKey(data, "backspace")) {
              if (query.length > 0) {
                query = query.slice(0, -1);
                rebuildList();
              }
            } else if (matchesKey(data, "ctrl+u")) {
              if (query.length > 0) {
                query = "";
                rebuildList();
              }
            } else if (isShortcutPaletteQueryInput(data)) {
              query += data;
              rebuildList();
            } else {
              selectList.handleInput(data);
            }
            tui.requestRender();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: () => ({
          verticalAlign: "center",
          horizontalAlign: "center",
        }),
      },
    );
    if (!selected) return;

    runShortcutPaletteEntry(ctx, selected);
  }

  function runShortcutPaletteEntry(ctx: any, entry: ShortcutPaletteEntry): void {
    if (entry.id.startsWith("powerline:")) {
      runPowerlineShortcutHelpEntry(ctx, entry.id.slice("powerline:".length) as PowerlineShortcutHelpKey);
      return;
    }

    if (!entry.runnable) {
      ctx.ui.notify("Reference only — use this key directly in its context", "info");
      return;
    }

    const actionId = entry.id.slice("pi:".length);
    if (actionId === "app.clipboard.pasteImage") {
      currentEditor?.onPasteImage?.();
      return;
    }

    const handlers = currentEditor?.actionHandlers;
    const handler = handlers instanceof Map ? handlers.get(actionId) : undefined;
    if (typeof handler === "function") {
      handler();
      return;
    }

    ctx.ui.notify("This action is unavailable right now", "warning");
  }

  function runPowerlineShortcutHelpEntry(ctx: any, key: PowerlineShortcutHelpKey): void {
    switch (key) {
      case "showShortcuts":
        return;
      case "stash":
        stashOrRestoreEditorText(ctx);
        return;
      case "bashToggle":
        runPowerlineShortcut(ctx, { kind: "bashMode" });
        return;
      case "stashHistory":
      case "copyEditor":
      case "cutEditor":
      case "reply":
        runPowerlineShortcut(ctx, { kind: key });
        return;
      case "editorStart":
      case "editorEnd": {
        if (typeof currentEditor?.moveCursorToEditorBoundary !== "function") {
          ctx.ui.notify("Editor cursor control is unavailable", "warning");
          return;
        }
        currentEditor.moveCursorToEditorBoundary(key === "editorStart" ? "start" : "end");
        return;
      }
    }
  }

  // Track session start
  pi.on("session_start", async (event, ctx) => {
    dismissWelcome(currentCtx ?? ctx);
    shellSession?.dispose();
    shellSession = null;
    sessionGeneration++;
    sessionStartTime = Date.now();
    currentCtx = ctx;
    footerDataRef = null;
    footerDataCwd = null;
    invalidateGitStatus();
    invalidateGitBranch();
    resetLayoutCache();
    customCompactionEnabled = detectCustomCompactionEnabled(ctx.cwd);
    lastUserPrompt = "";
    isStreaming = false;
    liveAssistantUsage = null;
    approximateContextUsage = event.reason === "reload" ? estimateUnknownContextUsage(ctx) : null;
    if (event.reason === "reload") {
      stashedEditorText = takeActiveStashReload(ctx);
    } else {
      stashedEditorText = null;
      clearActiveStashReload(ctx);
    }

    const settings = readSettings(ctx.cwd);
    resolvedShortcuts = resolveShortcutConfig(settings);
    bashModeSettings = parseBashModeSettings(settings, resolvedShortcuts);
    showLastPrompt = settings.showLastPrompt !== false;
    config = parsePowerlineConfig(settings.powerline, PRESET_NAMES);
    warnInvalidSegmentSettings(ctx);
    stashedPromptHistory = readPersistedStashHistory();
    bashModeActive = false;
    bashTranscript = new BashTranscriptStore(bashModeSettings);
    bashCompletionEngine = new BashCompletionEngine();

    getThinkingLevelFn = () => ctx.thinkingLevel ?? "off";
    currentThinkingLevel = getThinkingLevelFn();

    if (ctx.hasUI) {
      ctx.ui.setStatus("stash", stashedEditorText === null ? undefined : "stash");
    }

    if (enabled && ctx.hasUI) {
      setupCustomEditor(ctx);
      if (shouldShowStartupWelcome(event.reason, config.welcome, ctx.mode)) {
        if (settings.quietStartup === true) {
          setupWelcomeHeader(ctx);
        } else {
          setupWelcomeOverlay(ctx);
        }
      } else {
        dismissWelcome(ctx);
      }
    }

  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") {
      transferActiveStashReload(ctx, stashedEditorText);
    } else {
      clearActiveStashReload(ctx);
    }
    stashedEditorText = null;
    sessionGeneration++;
    dismissWelcome(ctx);
    restorePendingSend();
    statusRenderScheduler.cancel();
    restoreFooterStatusRepaintHook?.();
    restoreFooterStatusRepaintHook = null;
    stashShortcutInputUnsubscribe?.();
    stashShortcutInputUnsubscribe = null;
    shellSession?.dispose();
    shellSession = null;
    bashModeActive = false;
    currentCtx = null;
    footerDataRef = null;
    getThinkingLevelFn = null;
    currentThinkingLevel = null;
    liveAssistantUsage = null;
    tuiRef = null;
    currentEditor = null;
    resetLayoutCache();
  });

  // Check if a bash command might change git branch
  const mightChangeGitBranch = (cmd: string): boolean => {
    const gitBranchPatterns = [
      /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
      /\bgit\s+stash\s+(pop|apply)/,
    ];
    return gitBranchPatterns.some(p => p.test(cmd));
  };

  // Invalidate git status on file changes, trigger re-render on potential branch changes
  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
      requestStatusRender();
    }
    // Check for bash commands that might change git branch
    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (mightChangeGitBranch(cmd)) {
        // The command has completed, so start refreshing immediately.
        invalidateGitStatus();
        invalidateGitBranch();
        requestStatusRender();
      }
    }
  });

  // Also catch user escape commands (! prefix)
  // Note: This fires BEFORE execution, so we use a longer delay and multiple re-renders
  // to ensure we catch the update after the command completes.
  pi.on("user_bash", async (event) => {
    if (mightChangeGitBranch(event.command)) {
      // Invalidate immediately so next render fetches fresh data
      invalidateGitStatus();
      invalidateGitBranch();
      // Multiple staggered re-renders to catch fast and slow commands
      setTimeout(() => requestStatusRender(), 100);
      setTimeout(() => requestStatusRender(), 300);
      setTimeout(() => requestStatusRender(), 500);
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    currentCtx = ctx;
    coreContextUsageCache.reset();
    requestStatusRender();
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    currentCtx = ctx;
    currentThinkingLevel = resolveThinkingLevelSelection(event.level, getThinkingLevelFn?.());
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("session_tree", async (_event, ctx) => {
    currentCtx = ctx;
    currentThinkingLevel = null;
    liveAssistantUsage = null;
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    currentCtx = ctx;
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  // Custom-message turns have no user prompt and must preserve the current task.
  pi.on("before_agent_start", async (event, ctx) => {
    if ("messageType" in event && event.messageType === "custom") return;
    lastUserPrompt = event.prompt;
  });

  // Track streaming state (footer only shows status during streaming)
  // Also dismiss welcome when agent starts responding (handles `p "command"` case)
  pi.on("agent_start", async (_event, ctx) => {
    isStreaming = true;
    liveAssistantUsage = null;
    dismissWelcome(ctx);
    currentCtx = ctx;
  });

  pi.on("message_update", async (event, ctx) => {
    if (isSessionAssistantMessage(event.message)
      && event.message.stopReason !== "error"
      && event.message.stopReason !== "aborted"
      && getUsageTokenTotal(event.message.usage) > 0) {
      liveAssistantUsage = event.message.usage;
      currentCtx = ctx;
      layoutDirty = true;
      statusRenderScheduler.schedule(CONTEXT_STATUS_RENDER_MS);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    currentCtx = ctx;
    coreContextUsageCache.reset();
    if (isSessionAssistantMessage(event.message)) {
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        liveAssistantUsage = null;
      } else if (getUsageTokenTotal(event.message.usage) > 0) {
        liveAssistantUsage = event.message.usage;
      }
    }
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentCtx = ctx;
    coreContextUsageCache.reset();
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    currentCtx = ctx;
    isStreaming = false;
    liveAssistantUsage = null;
    approximateContextUsage = null;
    coreContextUsageCache.reset();
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("session_compact", async (_event, ctx) => {
    currentCtx = ctx;
    isStreaming = false;
    liveAssistantUsage = null;
    approximateContextUsage = estimateUnknownContextUsage(ctx);
    coreContextUsageCache.reset();
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  // Also dismiss on tool calls (agent is working)
  pi.on("tool_call", async (_event, ctx) => {
    dismissWelcome(ctx);
  });

  function dismissWelcome(ctx: any) {
    welcomeRequest?.abort();
    welcomeRequest = null;
    if (welcomeTimer) clearTimeout(welcomeTimer);
    welcomeTimer = null;
    if (dismissWelcomeOverlay) {
      dismissWelcomeOverlay();
      dismissWelcomeOverlay = null;
    }
    if (welcomeHeaderActive) {
      welcomeHeaderActive = false;
      ctx.ui.setHeader(undefined);
    }
  }

  function dismissWelcomeForInput(ctx: any) {
    if (!welcomeRequest && !dismissWelcomeOverlay && !welcomeHeaderActive) return;
    dismissWelcome(ctx);
  }

  function addStashHistoryEntry(text: string): void {
    const changed = pushStashHistory(stashedPromptHistory, text);
    if (!changed) {
      return;
    }

    persistStashHistory(stashedPromptHistory);
  }

  function copyTextToClipboard(ctx: any, text: string, successMessage?: string): void {
    copyToClipboard(text);
    if (successMessage) {
      ctx.ui.notify(successMessage, "info");
    }
  }

  function getEditorTextForClipboard(ctx: any): string | null {
    const text = getCurrentEditorText(ctx, currentEditor);
    if (hasNonWhitespaceText(text)) {
      return text;
    }

    ctx.ui.notify("Editor is empty", "info");
    return null;
  }

  async function selectStashedPromptFromHistory(ctx: any): Promise<string | null> {
    const historyItems = [...stashedPromptHistory];
    const items: SelectItem[] = historyItems.map((entry, index) => ({
      value: String(index),
      label: `#${index + 1} ${buildStashPreview(entry, STASH_PREVIEW_WIDTH)}`,
    }));

    const selected = await showSelectOverlay(
      ctx, "Stash history", "↑↓ navigate • enter insert • esc cancel",
      items, Math.min(items.length, 10));
    if (!selected) return null;

    const i = Number.parseInt(selected.value, 10);
    return historyItems[i] ?? null;
  }

  async function selectProjectPromptFromHistory(ctx: any, prompts: string[]): Promise<string | null> {
    const items: SelectItem[] = prompts.map((entry, index) => ({
      value: String(index),
      label: `#${index + 1} ${buildStashPreview(entry, STASH_PREVIEW_WIDTH)}`,
    }));

    const selected = await showSelectOverlay(
      ctx, "Recent project prompts", "↑↓ navigate • enter insert • esc cancel",
      items, Math.min(items.length, 10));
    if (!selected) return null;

    const i = Number.parseInt(selected.value, 10);
    return prompts[i] ?? null;
  }

  async function selectPromptHistorySource(
    ctx: any,
    stashCount: number,
  ): Promise<"stash" | "project" | null> {
    if (stashCount === 0) {
      return "project";
    }

    const items: SelectItem[] = [];

    items.push({
      value: "stash",
      label: "Stashed prompts",
      description: `${stashCount} saved`,
    });
    items.push({
      value: "project",
      label: "Recent project prompts",
      description: "load on demand",
    });

    const selected = await showSelectOverlay(
      ctx, "Prompt history", "↑↓ navigate • enter open • esc cancel",
      items, items.length);
    if (!selected) return null;

    return selected.value === "project" ? "project" : "stash";
  }

  async function insertSelectedPromptHistoryEntry(ctx: any, selected: string): Promise<void> {
    const currentText = getCurrentEditorText(ctx, currentEditor);
    if (!hasNonWhitespaceText(currentText)) {
      ctx.ui.setEditorText(selected);
      ctx.ui.notify("Inserted prompt", "info");
      return;
    }

    const action = await ctx.ui.select("Insert prompt", ["Replace", "Append", "Cancel"]);

    if (action === "Replace") {
      ctx.ui.setEditorText(selected);
      ctx.ui.notify("Replaced editor with prompt", "info");
      return;
    }

    if (action === "Append") {
      const separator = currentText.endsWith("\n") || selected.startsWith("\n") ? "" : "\n";
      ctx.ui.setEditorText(`${currentText}${separator}${selected}`);
      ctx.ui.notify("Appended prompt", "info");
    }
  }

  async function handleSelectedStashHistoryEntry(ctx: any, selected: string): Promise<void> {
    const action = await ctx.ui.select("Stashed prompt", ["Insert", "Cancel"]);
    if (action === "Insert") await insertSelectedPromptHistoryEntry(ctx, selected);
  }

  function isStashShortcutInput(data: string): boolean {
    return matchesStashShortcutInput(data, { includePrintableSharpS: config.stashSharpSShortcut });
  }

  function isPromptHistoryShortcutInput(data: string): boolean {
    return matchesConfiguredShortcut(data, resolvedShortcuts.stashHistory)
      || (resolvedShortcuts.stashHistory === "ctrl+alt+h" && (
        /^\x1b\[104(?::\d*)?(?::\d*)?;7(?::\d+)?u$/.test(data)
        || data === "\x1b[27;7;104~"
        || data === "\x1b[27;7;72~"
      ));
  }

  function getPowerlineShortcutAction(data: string): PowerlineShortcutAction | null {
    if (isKeyRelease(data)) return null;

    if (matchesConfiguredShortcut(data, resolvedShortcuts.showShortcuts)) {
      return { kind: "showShortcuts" };
    }
    if (isPromptHistoryShortcutInput(data)) {
      return { kind: "stashHistory" };
    }
    if (matchesConfiguredShortcut(data, resolvedShortcuts.copyEditor)) {
      return { kind: "copyEditor" };
    }
    if (matchesConfiguredShortcut(data, resolvedShortcuts.cutEditor)) {
      return { kind: "cutEditor" };
    }
    if (resolvedShortcuts.reply && matchesConfiguredShortcut(data, resolvedShortcuts.reply)) {
      return { kind: "reply" };
    }
    if (matchesConfiguredShortcut(data, bashModeSettings.toggleShortcut)) {
      return { kind: "bashMode" };
    }

    return null;
  }

  function runPowerlineShortcut(ctx: any, action: PowerlineShortcutAction): void {
    if (action.kind === "showShortcuts") {
      void showShortcutPalette(ctx);
      return;
    }

    if (action.kind === "stashHistory") {
      void openStashHistory(ctx);
      return;
    }

    if (action.kind === "copyEditor" || action.kind === "cutEditor") {
      const text = getEditorTextForClipboard(ctx);
      if (!text) return;

      copyTextToClipboard(ctx, text, action.kind === "copyEditor" ? "Copied editor text" : undefined);
      if (action.kind === "cutEditor") {
        ctx.ui.setEditorText("");
        ctx.ui.notify("Cut editor text", "info");
      }
      return;
    }

    if (action.kind === "reply") {
      void import("./quote-reply.ts").then(({ reply }) => reply("", ctx));
      return;
    }

    if (action.kind === "bashMode") {
      void setBashModeActive(!bashModeActive, ctx);
      return;
    }
  }

  function stashOrRestoreEditorText(ctx: any): void {
    const rawText = getCurrentEditorText(ctx, currentEditor);
    const hasStash = stashedEditorText !== null;

    if (!hasNonWhitespaceText(rawText)) {
      if (!hasStash) {
        ctx.ui.notify("Nothing to stash", "info");
        return;
      }

      ctx.ui.setEditorText(stashedEditorText);
      stashedEditorText = null;
      ctx.ui.setStatus("stash", undefined);
      ctx.ui.notify("Stash restored", "info");
      return;
    }

    stashedEditorText = rawText;
    addStashHistoryEntry(rawText);
    ctx.ui.setEditorText("");
    ctx.ui.setStatus("stash", "stash");
    ctx.ui.notify(hasStash ? "Stash updated" : "Text stashed", "info");
  }

  async function openStashHistory(ctx: any): Promise<void> {
    const source = await selectPromptHistorySource(ctx, stashedPromptHistory.length);
    if (!source) {
      return;
    }

    if (source === "project") {
      let projectPrompts: string[] = [];
      try {
        projectPrompts = readRecentProjectPrompts(ctx.cwd, PROJECT_PROMPT_HISTORY_LIMIT);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to load project prompts: ${message}`, "warning");
        return;
      }

      if (projectPrompts.length === 0) {
        ctx.ui.notify(stashedPromptHistory.length === 0 ? "No prompt history yet" : "No recent project prompts", "info");
        return;
      }

      const selected = await selectProjectPromptFromHistory(ctx, projectPrompts);
      if (!selected) return;

      await insertSelectedPromptHistoryEntry(ctx, selected);
      return;
    }

    const selected = await selectStashedPromptFromHistory(ctx);
    if (!selected) return;

    await handleSelectedStashHistoryEntry(ctx, selected);
  }

  pi.on("agent_end", async (_event, ctx) => {
    isStreaming = false;
    liveAssistantUsage = null;
    coreContextUsageCache.reset();

    let hasUI = false;
    try {
      hasUI = Boolean(ctx.hasUI);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
      currentCtx = null;
      return;
    }

    currentCtx = ctx;

    requestStatusRender();
  });

  registerCdCommand(pi, () => currentCtx?.cwd ?? process.cwd());

  pi.registerCommand("reply", {
    description: "Quote a previous user or assistant message into the editor",
    handler: async (args, ctx) => {
      const { reply } = await import("./quote-reply.ts");
      await reply(args, ctx);
    },
  });

  // Command to toggle/configure
  pi.registerCommand("powerline", {
    description: "Configure powerline status and shortcuts",
    handler: async (args, ctx) => {
      // Update context reference (command ctx may have more methods)
      currentCtx = ctx;

      if (!args?.trim()) {
        // Toggle
        enabled = !enabled;
        if (enabled) {
          setupCustomEditor(ctx);
          ctx.ui.notify("Powerline enabled", "info");
        } else {
          shellSession?.dispose();
          shellSession = null;
          bashTranscript.clear();
          bashModeActive = false;
          dismissWelcome(ctx);
          getPromptHistoryState().savedPromptHistory = [];
          stashedEditorText = null;
          clearActiveStashReload(ctx);
          ctx.ui.setStatus("stash", undefined);
          restoreFooterStatusRepaintHook?.();
          restoreFooterStatusRepaintHook = null;
          stashShortcutInputUnsubscribe?.();
          stashShortcutInputUnsubscribe = null;
          restorePendingSend();
          // Clear all custom UI components
          ctx.ui.setEditorComponent(undefined);
          ctx.ui.setFooter(undefined);
          ctx.ui.setHeader(undefined);
          ctx.ui.setWidget("powerline-top", undefined);
          ctx.ui.setWidget("powerline-secondary", undefined);
          ctx.ui.setWidget("powerline-bash-transcript", undefined);
          ctx.ui.setWidget("powerline-status", undefined);
          ctx.ui.setWidget("powerline-pending-send", undefined);
          ctx.ui.setWidget("powerline-last-prompt", undefined);
          footerDataRef = null;
          tuiRef = null;
          currentEditor = null;
          statusRenderScheduler.cancel();
          resetLayoutCache();
          ctx.ui.notify("Powerline disabled", "info");
        }
        return;
      }

      const normalizedArgs = args.trim().toLowerCase();
      if (normalizedArgs === "shortcuts") {
        if (ctx.hasUI) {
          await showShortcutPalette(ctx);
        }
        return;
      }

      const placementMatch = /^placement(?:\s+(above|below|toggle))?$/.exec(normalizedArgs);
      if (placementMatch) {
        const requestedPlacement = placementMatch[1];
        config.placement = requestedPlacement === "above" || requestedPlacement === "below"
          ? requestedPlacement
          : config.placement === "above" ? "below" : "above";
        config.invalidPlacement = null;
        if (enabled && ctx.hasUI) setupCustomEditor(ctx);

        if (writePowerlineOptionSetting(ctx.cwd, { placement: config.placement }, config.preset)) {
          ctx.ui.notify(`Powerline placement set to: ${config.placement}`, "info");
        } else {
          ctx.ui.notify(`Powerline placement set to: ${config.placement} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      const preset = normalizePreset(args);
      if (preset) {
        config.preset = preset;
        resetLayoutCache();
        if (enabled) {
          setupCustomEditor(ctx);
        }

        if (writePowerlinePresetSetting(preset, ctx.cwd)) {
          ctx.ui.notify(`Preset set to: ${preset}`, "info");
        } else {
          ctx.ui.notify(`Preset set to: ${preset} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      // Show available presets
      const presetList = Object.keys(PRESETS).join(", ");
      ctx.ui.notify(`Available presets: ${presetList}`, "info");
    },
  });

  pi.registerCommand("stash-history", {
    description: "Open prompt history picker",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (!enabled) {
        ctx.ui.notify("Powerline is disabled", "info");
        return;
      }

      await openStashHistory(ctx);
    },
  });

  pi.registerCommand("bash-mode", {
    description: "Toggle sticky bash mode (on, off, toggle)",
    handler: async (args, ctx) => {
      const mode = args?.trim().toLowerCase() || "toggle";
      if (mode === "on") {
        await setBashModeActive(true, ctx);
        return;
      }
      if (mode === "off") {
        await setBashModeActive(false, ctx);
        return;
      }
      if (mode === "toggle") {
        await setBashModeActive(!bashModeActive, ctx);
        return;
      }
      ctx.ui.notify("Usage: /bash-mode [on|off|toggle]", "warning");
    },
  });

  pi.registerCommand("bash-reset", {
    description: "Reset the managed bash session",
    handler: async (_args, ctx) => {
      shellSession?.dispose();
      shellSession = null;
      bashTranscript.clear();
      if (bashModeActive) {
        try {
          await ensureShellSession();
        } catch (error) {
          bashModeActive = false;
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to restart shell session: ${message}`, "error");
          requestStatusRender();
          return;
        }
      }
      requestStatusRender();
      ctx.ui.notify("Bash session reset", "info");
    },
  });


  function buildSegmentContext(ctx: any, theme: Theme, allSegmentIds: StatusLineSegmentId[]): SegmentContext {
    const presetDef = getPreset(config.preset);
    const colors: ColorScheme = presetDef.colors ?? getDefaultColors();

    // Build usage stats and get thinking level from session (cached; the full
    // event list is only re-scanned when events are appended or the trailing
    // event's stats-relevant fields change, e.g. in-place streaming updates)
    const sessionEvents = sessionBranchCache.get(ctx.sessionManager);
    const tokenStats = tokenStatsCache.get(sessionEvents);
    const { input, output, cacheRead, cacheWrite, cost, subagentCost } = tokenStats;
    const lastAssistant = tokenStats.lastAssistant;
    const thinkingLevelFromSession = tokenStats.thinkingLevelFromSession;

    // Calculate context percentage.
    const latestUsage = isStreaming ? liveAssistantUsage ?? lastAssistant?.usage : lastAssistant?.usage;
    const coreContextUsage = isStreaming && liveAssistantUsage ? null : coreContextUsageCache.get(ctx);
    const fallbackContextTokens = latestUsage ? getUsageTokenTotal(latestUsage) : 0;
    const {
      contextTokens,
      contextWindow,
      contextPercent,
    } = resolveDisplayContextUsage({
      coreContextUsage,
      unknownCoreFallback: approximateContextUsage,
      fallbackContextTokens,
      fallbackContextWindow: ctx.model?.contextWindow ?? 0,
    });
    const contextApproximate = coreContextUsage?.contextTokens === null && approximateContextUsage !== null;

    const segmentOptions = mergeSegmentOptions(presetDef.segmentOptions, config.segmentOptions);

    const gitOptions = segmentOptions.git;
    const showGit = allSegmentIds.includes("git") && [
      gitOptions?.showBranch, gitOptions?.showStaged, gitOptions?.showUnstaged, gitOptions?.showUntracked,
    ].some((visible) => visible !== false);
    const gitBranch = showGit && footerDataCwd === ctx.cwd
      ? footerDataRef?.getGitBranch() ?? null
      : null;
    // Full mode retains counts for dirty branch coloring, even with hidden indicators.
    const gitStatus = showGit
      ? getGitStatus(gitBranch, gitOptions?.polling, ctx.cwd)
      : { branch: null, staged: 0, unstaged: 0, untracked: 0 };
    const extensionStatuses = footerDataRef?.getExtensionStatuses() ?? new Map();
    const customItemsById = new Map(config.customItems.map((item) => [item.id, item]));
    const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);

    // Check if the selected provider has subscription limits available.
    const subscriptionUsageProvider = getSupportedSubscriptionProvider(ctx.model);
    const usingSubscription = isSubscriptionUsageEnabled(
      subscriptionUsageProvider,
      ctx.model ? ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false : false,
    );
    if (usingSubscription) {
      ensureSubscriptionUsage(ctx);
    }

    const subscriptionUsage = usingSubscription && subscriptionUsageProvider
      ? subscriptionUsageByProvider.get(subscriptionUsageProvider)?.usage ?? null
      : null;

    const thinkingLevel = currentThinkingLevel ?? thinkingLevelFromSession ?? getThinkingLevelFn?.() ?? "off";

    return {
      model: ctx.model,
      thinkingLevel,
      sessionId: ctx.sessionManager?.getSessionId?.(),
      sessionName: ctx.sessionManager?.getSessionName?.(),
      cwd: ctx.cwd,
      usageStats: { input, output, cacheRead, cacheWrite, cost, subagentCost },
      contextTokens,
      contextPercent,
      contextWindow,
      contextApproximate,
      autoCompactEnabled: ctx.settingsManager?.getCompactionSettings?.()?.enabled ?? true,
      customCompactionEnabled: customCompactionEnabled || extensionStatuses.has(CUSTOM_COMPACTION_STATUS_KEY),
      usingSubscription,
      subscriptionUsage,
      sessionStartTime,
      shellModeActive: bashModeActive,
      shellRunning: shellSession?.state.running ?? false,
      shellName: shellSession?.state.shellName ?? null,
      shellCwd: shellSession?.state.cwd ?? null,
      git: gitStatus,
      extensionStatuses,
      hiddenExtensionStatusKeys,
      customItemsById,
      options: segmentOptions,
      theme,
      colors,
    };
  }

  /**
   * Get cached responsive layout or compute fresh one.
   * The segment context scans session state, so keep it stable across render bursts.
   */
  function getResponsiveLayout(width: number, theme: Theme): ResponsiveLayout {
    const now = Date.now();
    const cacheTtl = isStreaming ? STREAMING_LAYOUT_CACHE_TTL_MS : LAYOUT_CACHE_TTL_MS;

    if (lastLayoutResult && lastLayoutWidth === width) {
      const msSinceInput = now - lastEditorInputAt;
      const typingRecently = msSinceInput < EDITOR_STATUS_DEFER_MS;

      if (!forceNextLayoutRecompute && typingRecently && (layoutDirty || now - lastLayoutTimestamp >= cacheTtl)) {
        return lastLayoutResult;
      }

      if (!layoutDirty && now - lastLayoutTimestamp < cacheTtl) {
        return lastLayoutResult;
      }
    }

    const presetDef = getPreset(config.preset);
    const mergedSegments = mergeSegmentsWithCustomItems(presetDef, config.customItems, {
      layout: config.layout,
      disabledSegments: config.disabledSegments,
    });
    const allSegmentIds = [
      ...mergedSegments.leftSegments,
      ...mergedSegments.rightSegments,
      ...mergedSegments.secondarySegments,
    ];
    let segmentCtx: SegmentContext;
    try {
      segmentCtx = buildSegmentContext(currentCtx, theme, allSegmentIds);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
      currentCtx = null;
      lastLayoutWidth = width;
      lastLayoutResult = { topContent: "", secondaryLines: [] };
      lastLayoutTimestamp = now;
      layoutDirty = false;
      forceNextLayoutRecompute = false;
      return lastLayoutResult;
    }

    lastLayoutWidth = width;
    lastLayoutResult = computeResponsiveLayout(segmentCtx, presetDef, allSegmentIds, width);
    lastLayoutTimestamp = now;
    layoutDirty = false;
    forceNextLayoutRecompute = false;

    return lastLayoutResult;
  }

  function renderPowerlineStatusLines(width: number): string[] {
    if (!currentCtx || !footerDataRef) return [];

    const statuses = footerDataRef.getExtensionStatuses();
    if (!statuses || statuses.size === 0) return [];
    const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);

    const notifications: string[] = [];
    for (const value of getNotificationExtensionStatuses(statuses, hiddenExtensionStatusKeys)) {
      const lineContent = ` ${value}`;
      if (visibleWidth(lineContent) <= width) {
        notifications.push(lineContent);
      }
    }

    return notifications;
  }

  function renderPowerlinePrimaryLines(width: number, theme: Theme): string[] {
    if (!currentCtx) return [];

    const layout = getResponsiveLayout(width, theme);
    return layout.topContent ? [layout.topContent] : [];
  }

  function renderPowerlineSecondaryLines(width: number, theme: Theme): string[] {
    if (!currentCtx) return [];

    return [...getResponsiveLayout(width, theme).secondaryLines];
  }

  function renderPendingSendLines(width: number, theme: Theme): string[] {
    if (!pendingSend) return [];
    const seconds = Math.max(1, Math.ceil((pendingSend.deadline - Date.now()) / 1000));
    const hint = theme.fg("accent", `sending in ${seconds}s · esc to edit · enter to send now`);
    const preview = theme.fg("dim", pendingSend.text.replace(/\s+/g, " "));
    return [truncateToWidth(` ${hint}  ${preview}`, width, "…")];
  }

  function renderBashTranscriptLines(width: number, theme: Theme): string[] {
    if (!bashModeActive) return [];

    const snapshot = bashTranscript.getSnapshot();
    if (snapshot.commands.length === 0) return [];

    const lines: string[] = [];
    if (snapshot.truncatedCommands > 0) {
      lines.push(` ${theme.fg("dim", `… ${snapshot.truncatedCommands} earlier command${snapshot.truncatedCommands === 1 ? "" : "s"} truncated`)}`);
    }

    const recentCommands = snapshot.commands.slice(-4);
    for (const command of recentCommands) {
      const promptGlyph = (shellSession?.state.shellName ?? "shell") === "fish" ? ">" : "$";
      const status = command.exitCode === null
        ? theme.fg("accent", "running")
        : command.exitCode === 0
          ? theme.fg("success", "ok")
          : theme.fg("error", `exit ${command.exitCode}`);
      const commandLine = truncateToWidth(command.command.replace(/\s+/g, " ").trim(), Math.max(8, width - 8), "…");
      lines.push(` ${theme.fg("accent", promptGlyph)} ${commandLine} ${theme.fg("dim", "(")}${status}${theme.fg("dim", ")")}`);

      const outputTail = command.output.slice(-6);
      for (const outputLine of outputTail) {
        lines.push(`   ${truncateToWidth(outputLine, Math.max(1, width - 3), "…")}`);
      }
    }

    return lines.slice(-16);
  }

  function renderLastPromptLines(width: number): string[] {
    if (bashModeActive || !showLastPrompt || !lastUserPrompt) return [];

    const color = getFgAnsiCode("sep");
    if (
      lastPromptRenderCache
      && lastPromptRenderCache.source === lastUserPrompt
      && lastPromptRenderCache.width === width
      && lastPromptRenderCache.color === color
    ) {
      return lastPromptRenderCache.lines;
    }

    const compact = lastPromptRenderCache?.source === lastUserPrompt
      ? lastPromptRenderCache.compact
      : lastUserPrompt.replace(/\s+/g, " ").trim();
    const prefix = ` ${color}↳${ansi.reset} `;
    const availableWidth = width - visibleWidth(prefix);
    const lines = compact && availableWidth >= 10
      ? [truncateToWidth(`${prefix}${color}${truncateToWidth(compact, availableWidth, "…")}${ansi.reset}`, width, "…")]
      : [];

    lastPromptRenderCache = { source: lastUserPrompt, compact, width, color, lines };
    return lines;
  }

  function installPowerlineWidgets(ctx: any) {
    // Web frontends such as pi-web bind extensions in "rpc" mode, render widget
    // factories themselves, and show every widget as a panel even when it renders
    // nothing. Outside the TUI only the primary bar has content to show.
    const terminalWidgets = ctx.mode === "tui";

    if (terminalWidgets) {
      ctx.ui.setWidget("powerline-status", () => ({
        dispose() {},
        invalidate() {
          requestStatusRender();
        },
        render(width: number): string[] {
          return renderPowerlineStatusLines(width);
        },
      }), { placement: "aboveEditor" });
    }

    ctx.ui.setWidget("powerline-top", (_tui: any, theme: Theme) => ({
      dispose() {},
      invalidate() {
        resetLayoutCache();
      },
      render(width: number): string[] {
        return renderPowerlinePrimaryLines(width, theme);
      },
    }), { placement: config.placement === "below" ? "belowEditor" : "aboveEditor" });

    if (!terminalWidgets) return;

    ctx.ui.setWidget("powerline-bash-transcript", (_tui: any, theme: Theme) => ({
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        return renderBashTranscriptLines(width, theme);
      },
    }), { placement: "belowEditor" });

    ctx.ui.setWidget("powerline-pending-send", (_tui: any, theme: Theme) => ({
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        return renderPendingSendLines(width, theme);
      },
    }), { placement: "belowEditor" });

    ctx.ui.setWidget("powerline-last-prompt", () => ({
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        return renderLastPromptLines(width);
      },
    }), { placement: "belowEditor" });
  }

  function setupCustomEditor(ctx: any) {
    snapshotPromptHistory(currentEditor);
    if (!enabled) {
      return;
    }

    stashShortcutInputUnsubscribe?.();
    stashShortcutInputUnsubscribe = typeof ctx.ui.onTerminalInput === "function"
      ? ctx.ui.onTerminalInput((data: string) => {
        if (!enabled || !ctx.hasUI || tuiRef?.hasOverlay?.()) {
          return undefined;
        }
        if (isStashShortcutInput(data)) {
          stashOrRestoreEditorText(ctx);
          dismissWelcomeForInput(ctx);
          tuiRef?.requestRender();
          return { consume: true };
        }

        const powerlineShortcutAction = getPowerlineShortcutAction(data);
        if (!powerlineShortcutAction) {
          return undefined;
        }

        runPowerlineShortcut(ctx, powerlineShortcutAction);
        dismissWelcomeForInput(ctx);
        tuiRef?.requestRender();
        return { consume: true };
      })
      : null;

    ctx.ui.setWidget("powerline-top", undefined);
    ctx.ui.setWidget("powerline-secondary", undefined);
    ctx.ui.setWidget("powerline-bash-transcript", undefined);
    ctx.ui.setWidget("powerline-status", undefined);
    ctx.ui.setWidget("powerline-pending-send", undefined);
    ctx.ui.setWidget("powerline-last-prompt", undefined);

    let autocompleteFixed = !bashModeSettings.completions;
    const previousEditorFactory = typeof ctx.ui.getEditorComponent === "function" ? ctx.ui.getEditorComponent() : undefined;

    const editorFactory = (tui: any, editorTheme: any, keybindings: any) => {
      const previousEditor = previousEditorFactory?.(tui, editorTheme, keybindings);
      const editor = new BashModeEditor(tui, editorTheme, keybindings, {
        keybindings,
        isBashModeActive: () => bashModeActive,
        isShellRunning: () => shellSession?.state.running ?? false,
        onExitBashMode: () => {
          void setBashModeActive(false, ctx);
        },
        onSubmitCommand: (command) => void runShellCommand(command, ctx),
        editorBoundaryShortcuts: {
          start: resolvedShortcuts.editorStart,
          end: resolvedShortcuts.editorEnd,
        },
        onInterrupt: () => {
          shellSession?.interrupt();
          ctx.ui.notify("Sent interrupt to shell", "info");
        },
        onNotify: (message, level = "info") => ctx.ui.notify(message, level),
        getHistoryEntries: (prefix) => getShellHistoryEntries(prefix),
        areCompletionsEnabled: () => bashModeSettings.completions,
        resolveGhostSuggestion: async (text, signal) => {
          const oneOffBash = getOneOffBashCommandContext(text);
          if (oneOffBash) {
            const ghost = await bashCompletionEngine.getGhostSuggestion(
              oneOffBash.command,
              getShellCwd(),
              getShellPath(),
              signal,
            );
            return ghost ? { ...ghost, value: `${oneOffBash.prefix}${ghost.value}` } : null;
          }

          return bashCompletionEngine.getGhostSuggestion(text, getShellCwd(), getShellPath(), signal);
        },
      });

      let installingPowerlineAutocompleteProvider = false;
      // Pi assigns onSubmit after this factory returns and calls it from every submit path, so the delay wraps it here.
      let piSubmit: ((text: string) => unknown) | undefined;
      Object.defineProperty(editor, "onSubmit", {
        configurable: true,
        get: () => {
          const submit = piSubmit;
          return submit && ((text: string) => submitWithDelay(text, submit));
        },
        set: (handler: ((text: string) => unknown) | undefined) => {
          piSubmit = handler;
        },
      });

      const originalSetAutocompleteProvider = editor.setAutocompleteProvider.bind(editor);
      editor.setAutocompleteProvider = (provider: AutocompleteProvider) => {
        if (installingPowerlineAutocompleteProvider) {
          originalSetAutocompleteProvider(provider);
          return;
        }

        originalSetAutocompleteProvider(passAutocompleteProviderThroughPreviousEditor(provider, previousEditor));
        attachAutocompleteProvider();
      };

      const getInstalledAutocompleteProvider = (): AutocompleteProvider | undefined => {
        return getEditorAutocompleteProvider(editor) ?? getEditorAutocompleteProvider(previousEditor);
      };

      const attachAutocompleteProvider = (): boolean => {
        if (!bashModeSettings.completions) return false;
        if (editor.hasWrappedProvider()) return true;
        const defaultProvider = getInstalledAutocompleteProvider();
        if (!defaultProvider) return false;

        const bashProvider = new BashAutocompleteProvider();
        const oneOffBashProvider = new OneOffBashAutocompleteProvider();
        installingPowerlineAutocompleteProvider = true;
        try {
          editor.installAutocompleteProvider(
            new ModeAwareAutocompleteProvider(defaultProvider, bashProvider, oneOffBashProvider, () => bashModeActive),
          );
        } finally {
          installingPowerlineAutocompleteProvider = false;
        }
        return true;
      };

      currentEditor = editor;
      trackPromptHistory(editor);
      restorePromptHistory(editor);
      attachAutocompleteProvider();

      const originalHandleInput = editor.handleInput.bind(editor);
      const handlePowerlineEditorInput = (data: string) => {
        lastEditorInputAt = Date.now();
        dismissWelcomeForInput(ctx);

        if (isPrintableInput(data)) {
          originalHandleInput(data);
          return;
        }

        if (pendingSend && !bashModeActive && keybindings.matches(data, "app.interrupt") && !editor.isShowingAutocomplete()) {
          restorePendingSend();
          return;
        }

        // Ctrl+S is handled only here, where the editor has focus: Pi's
        // selectors use it to save defaults and toggle session sort.
        if (isStashShortcutInput(data) || matchesCtrlSStashInput(data)) {
          stashOrRestoreEditorText(ctx);
          return;
        }

        const powerlineShortcutAction = getPowerlineShortcutAction(data);
        if (powerlineShortcutAction) {
          runPowerlineShortcut(ctx, powerlineShortcutAction);
          return;
        }

        if (!autocompleteFixed && !getInstalledAutocompleteProvider()) {
          autocompleteFixed = true;
          snapshotPromptHistory(editor);
          ctx.ui.setEditorComponent(editorFactory);
          currentEditor?.handleInput(data);
          return;
        }

        if (bashModeSettings.completions) {
          attachAutocompleteProvider();
        }
        originalHandleInput(data);
      };
      editor.handleInput = handlePowerlineEditorInput;

      const originalRender = editor.render.bind(editor);
      editor.render = (width: number): string[] => {
        const renderPowerlineEditor = (): string[] => {
          const fastLines = renderFastPowerlineEditor(editor, width, {
            bashModeActive,
            completionsEnabled: bashModeSettings.completions,
          });
          if (fastLines) return fastLines;

          if (width < 10) return originalRender(width);

          const promptGlyph = bashModeActive ? "$" : ">";
          const promptColor = ansi.getFgAnsi(200, 200, 200);
          const prompt = `${promptColor}${promptGlyph}${ansi.reset}`;
          const promptPrefix = ` ${prompt} `;
          const contPrefix = "   ";
          const contentWidth = Math.max(1, width - 3);
          const lines = originalRender(contentWidth);

          if (lines.length === 0) return lines;

          let bottomBorderIndex = lines.length - 1;
          for (let i = lines.length - 1; i >= 1; i--) {
            const stripped = lines[i]?.replace(/\x1b\[[0-9;]*m/g, "") || "";
            if (stripped.length > 0 && /^─{3,}/.test(stripped)) {
              bottomBorderIndex = i;
              break;
            }
          }

          const result: string[] = [];
          result.push(" " + colorEditorBorder(editor, "─".repeat(width - 2)));

          for (let i = 1; i < bottomBorderIndex; i++) {
            const prefix = i === 1 ? promptPrefix : contPrefix;
            result.push(`${prefix}${lines[i] || ""}`);
          }

          if (bottomBorderIndex === 1) {
            result.push(`${promptPrefix}${" ".repeat(contentWidth)}`);
          }

          result.push(" " + colorEditorBorder(editor, "─".repeat(width - 2)));

          for (let i = bottomBorderIndex + 1; i < lines.length; i++) {
            result.push(lines[i] || "");
          }

          return result;
        };

        return renderPowerlineEditor();
      };

      return editor;
    };

    ctx.ui.setEditorComponent(editorFactory);

    ctx.ui.setFooter((tui: any, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      footerDataRef = footerData;
      // Pi sets the provider cwd from sessionManager before binding session_start.
      // Do not treat its branch as authoritative if the extension cwd differs.
      footerDataCwd = ctx.sessionManager?.getCwd?.() ?? null;
      tuiRef = tui;
      installFooterStatusRepaintHook(footerData);
      const unsub = footerData.onBranchChange(() => {
        invalidateGitStatus();
        invalidateGitBranch();
        requestStatusRender();
      });
      const unsubGitUpdates = subscribeGitUpdates(() => requestStatusRender());

      return {
        dispose() {
          unsub();
          unsubGitUpdates();
          footerDataRef = null;
          footerDataCwd = null;
          restoreFooterStatusRepaintHook?.();
          restoreFooterStatusRepaintHook = null;
        },
        invalidate() {
          requestStatusRender();
        },
        render(width: number): string[] {
          return renderPowerlineSecondaryLines(width, theme);
        },
      };
    });

    installPowerlineWidgets(ctx);
  }

  function beginWelcomeRequest(ctx: any): AbortController {
    dismissWelcome(ctx);
    welcomeRequest = new AbortController();
    return welcomeRequest;
  }

  function canShowWelcome(ctx: any, request: AbortController, generation: number): boolean {
    if (request !== welcomeRequest || request.signal.aborted || generation !== sessionGeneration
      || !enabled || !config.welcome || !ctx.hasUI || isStreaming
      || ctx.ui.getEditorText()) return false;
    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
    return !sessionEvents.some((entry: unknown) => {
      if (!isRecord(entry)) return false;
      if (entry.type === "tool_call" || entry.type === "tool_result") return true;
      return entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant";
    });
  }

  function setupWelcomeHeader(ctx: any) {
    const request = beginWelcomeRequest(ctx);
    const generation = sessionGeneration;
    // Keep optional archive discovery off the session_start completion path.
    welcomeTimer = setTimeout(async () => {
      welcomeTimer = null;
      try {
        if (!canShowWelcome(ctx, request, generation)) return;
        const recentSessions = await getRecentSessions(3, request.signal);
        if (!canShowWelcome(ctx, request, generation)) return;
        const modelName = ctx.model?.name || ctx.model?.id || "No model";
        const providerName = ctx.model?.provider || "Unknown";
        const loadedCounts = discoverLoadedCounts(pi.getCommands());
        const initialContextTokens = estimateInitialContextTokens(ctx);

        const header = new WelcomeHeader(modelName, providerName, recentSessions, loadedCounts, initialContextTokens);
        welcomeHeaderActive = true;
        ctx.ui.setHeader(() => header);
      } catch (error: unknown) {
        if (!request.signal.aborted || error !== request.signal.reason) {
          console.debug("[pi-power-user] Welcome header failed:", error);
        }
      }
    }, 0);
  }

  function setupWelcomeOverlay(ctx: any) {
    const request = beginWelcomeRequest(ctx);
    const modelName = ctx.model?.name || ctx.model?.id || "No model";
    const providerName = ctx.model?.provider || "Unknown";

    const overlaySessionGeneration = sessionGeneration;

    // Small delay to let pi-mono finish initialization
    welcomeTimer = setTimeout(async () => {
      welcomeTimer = null;
      try {
        if (!canShowWelcome(ctx, request, overlaySessionGeneration)) return;
        const recentSessions = await getRecentSessions(3, request.signal);
        if (!canShowWelcome(ctx, request, overlaySessionGeneration)) return;
        const loadedCounts = discoverLoadedCounts(pi.getCommands());
        const initialContextTokens = estimateInitialContextTokens(ctx);

        void ctx.ui.custom(
          (tui: any, _theme: any, _keybindings: any, done: (result: void) => void) => {
            if (!canShowWelcome(ctx, request, overlaySessionGeneration)) {
              done();
              return { render: () => [], invalidate() {} };
            }
            const welcome = new WelcomeComponent(
              modelName,
              providerName,
              recentSessions,
              loadedCounts,
              initialContextTokens,
            );

            let countdown = 30;
            let dismissed = false;
            let interval: ReturnType<typeof setInterval> | null = null;

            const dismiss = () => {
              if (dismissed) return;
              dismissed = true;
              if (interval) clearInterval(interval);
              request.abort();
              if (welcomeRequest === request) welcomeRequest = null;
              dismissWelcomeOverlay = null;
              done();
            };

            interval = setInterval(() => {
              if (dismissed) return;
              countdown--;
              welcome.setCountdown(countdown);
              tui.requestRender();
              if (countdown <= 0) dismiss();
            }, 1000);

            dismissWelcomeOverlay = dismiss;

            return {
              focused: false,
              wantsKeyRelease: true,
              invalidate: () => welcome.invalidate(),
              render: (width: number) => welcome.render(width),
              handleInput: (data: string) => {
                dismiss();
                if (!isKeyRelease(data)) currentEditor?.handleInput(data);
              },
              dispose: dismiss,
            };
          },
          {
            overlay: true,
            overlayOptions: () => ({
              verticalAlign: "center",
              horizontalAlign: "center",
            }),
          },
        ).catch((error: unknown) => {
          console.debug("[pi-power-user] Welcome overlay failed:", error);
        });
      } catch (error: unknown) {
        if (!request.signal.aborted || error !== request.signal.reason) {
          console.debug("[pi-power-user] Welcome overlay failed:", error);
        }
      }
    }, 100);
  }
}
