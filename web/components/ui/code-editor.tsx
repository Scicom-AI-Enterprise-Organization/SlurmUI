"use client";

import { useEffect, useMemo, useState } from "react";
import CodeMirror, { type Extension } from "@uiw/react-codemirror";
import { keymap } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { githubLight, githubDark } from "@uiw/codemirror-theme-github";

interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  /**
   * Path or filename — used only to guess the language extension. If you
   * already know the language, just pass any filename ending in the right
   * extension (e.g. "x.py").
   */
  filename?: string;
  /** Fired on Ctrl/Cmd+S inside the editor. Return false to allow default. */
  onSave?: () => void;
  /**
   * Apply layout via this className on the editor's bounding box. The
   * editor itself always fills 100% of that box (with internal scrolling)
   * so it shows scrollbars regardless of how deep the flex layout is.
   */
  className?: string;
  readOnly?: boolean;
  /** Editor font size in px. Defaults to 12. */
  fontSize?: number;
  placeholder?: string;
}

/**
 * Inspect the file content and pick the indent style the file already uses.
 * Falls back to 4 spaces (Python convention) when the file is empty or has
 * no leading whitespace anywhere.
 */
function detectIndent(text: string, filename: string | undefined): {
  unit: string;
  useTabs: boolean;
  size: number;
} {
  // Skim only the first ~500 lines — enough to nail the predominant style
  // and avoids scanning huge files synchronously on each open.
  const lines = text.split("\n", 500);
  let tabCount = 0;
  const spaceCounts = new Map<number, number>();
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line[0] === "\t") {
      tabCount++;
      continue;
    }
    const m = line.match(/^( +)\S/);
    if (m) {
      const n = m[1].length;
      spaceCounts.set(n, (spaceCounts.get(n) ?? 0) + 1);
    }
  }
  // Tab if we saw any meaningful number of tab-indented lines.
  if (tabCount >= 3) return { unit: "\t", useTabs: true, size: 4 };

  // Pick the smallest indent width that appears at least a few times —
  // that's the "indent unit". A 4-space file will have many lines starting
  // with 4 spaces and many with 8, 12, etc.; the smallest is 4.
  const candidates: number[] = [];
  for (const [width, count] of spaceCounts) {
    if (count >= 2 && (width === 2 || width === 4 || width === 8)) {
      candidates.push(width);
    }
  }
  if (candidates.length > 0) {
    const size = Math.min(...candidates);
    return { unit: " ".repeat(size), useTabs: false, size };
  }
  // Empty file or no leading whitespace yet — pick a conventional default
  // by extension. We hit this only when the file has nothing to learn from.
  const lower = filename?.toLowerCase() ?? "";
  const size =
    lower.endsWith(".py") || lower.endsWith(".pyi") || lower.endsWith(".go") || lower.endsWith(".java") ? 4 :
    // yaml / json / js / ts / html / css / md etc. all conventionally 2.
    2;
  return { unit: " ".repeat(size), useTabs: false, size };
}

/**
 * Pick the CodeMirror language extension based on file extension. Anything
 * unrecognised falls back to plain text (no extension) — CodeMirror still
 * gives you line numbers, search, etc.
 */
function languageForFilename(filename: string | undefined): Extension[] {
  if (!filename) return [];
  const lower = filename.toLowerCase();
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return [python()];
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return [javascript({ jsx: true, typescript: true })];
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return [javascript({ jsx: lower.endsWith(".jsx") })];
  }
  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return [json()];
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return [markdown()];
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return [yaml()];
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return [html()];
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less")) return [css()];
  // Bash / shell — uses @codemirror/legacy-modes' stream-based shell mode.
  // Covers .sh / .bash and the job-submission "cmd.sh" / "job.sh" surfaces.
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) {
    return [StreamLanguage.define(shell)];
  }
  return [];
}

export function CodeEditor({
  value,
  onChange,
  filename,
  onSave,
  className,
  readOnly,
  fontSize = 12,
  placeholder,
}: CodeEditorProps) {
  // The app toggles dark mode via the `dark` class on <html>, no
  // ThemeProvider in the tree, so next-themes' useTheme wouldn't see it.
  // Watch the class list directly instead.
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const sync = () => setIsDark(root.classList.contains("dark"));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  // Detect indent (a) when the file changes and (b) the first time content
  // arrives. Parents usually open the editor with empty value and stream the
  // real content in next — if we only watched `filename` we'd detect against
  // the empty placeholder and never re-run. Watching `value.length > 0`
  // gives us one extra run on the empty→loaded transition, then it stays
  // stable across keystrokes so the IndentUnit facet doesn't churn.
  const detected = useMemo(
    () => detectIndent(value, filename),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filename, value.length > 0],
  );

  // Memoise extensions so CodeMirror doesn't recreate them every render
  // (each new array would re-mount the editor and reset cursor/selection).
  const extensions = useMemo<Extension[]>(() => {
    const langs = languageForFilename(filename);
    const indentExts: Extension[] = [
      // indentUnit is the *string* inserted for one indent level — set it
      // to "    " / "  " / "\t" based on what the file already uses, and
      // CodeMirror's language modes will indent in that style.
      indentUnit.of(detected.unit),
      // tabSize controls only how a literal \t is rendered.
      EditorState.tabSize.of(detected.size),
      // Tab key inserts the configured indent (spaces or a real tab,
      // matching the file's existing style). Without this, Tab moves focus.
      keymap.of([indentWithTab]),
    ];
    const saveKeymap = onSave
      ? keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSave();
              return true;
            },
          },
        ])
      : null;
    return saveKeymap ? [...langs, ...indentExts, saveKeymap] : [...langs, ...indentExts];
  }, [filename, detected, onSave]);

  const theme = isDark ? githubDark : githubLight;

  // CodeMirror only scrolls when .cm-editor has a real pixel height. A
  // height="100%" inside a flex chain often resolves to 0/auto and the
  // editor grows with content instead. Wrap in a position: relative box and
  // pin CodeMirror absolutely so it always inherits an explicit size from
  // its flex parent, regardless of how deep the layout is.
  return (
    <div
      className={className}
      style={{ fontSize: `${fontSize}px`, position: "relative" }}
    >
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <CodeMirror
          value={value}
          onChange={onChange}
          height="100%"
          maxHeight="100%"
          style={{ height: "100%" }}
          theme={theme}
          readOnly={readOnly}
          extensions={extensions}
          placeholder={placeholder}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            indentOnInput: true,
            autocompletion: true,
            searchKeymap: true,
          }}
        />
      </div>
    </div>
  );
}
