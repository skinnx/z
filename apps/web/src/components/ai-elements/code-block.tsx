/**
 * Adapted from AI Elements `code-block` (https://elements.ai-sdk.dev/components/code-block).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE and ./NOTICE.
 * Modified for z: highlighting goes through the lazily loaded @streamdown/code plugin (one Shiki
 * for replies and code blocks, loaded on first use), z's IconButton instead of shadcn's Button,
 * z tokens and strings; the language selector is left out.
 */
import { Check, Copy } from "lucide-react";
import type { CSSProperties, HTMLAttributes } from "react";
import { createContext, memo, useContext, useEffect, useRef, useState } from "react";
import type { HighlightResult, HighlightToken } from "streamdown";
import { useT } from "../../i18n.ts";
import { cn } from "../../lib/cn.ts";
import { IconButton } from "../../ui/icon-button.tsx";
import { highlight } from "./streamdown-plugins.ts";

const plain = (code: string): HighlightResult => ({ tokens: code.split("\n").map((line) => (line ? [{ content: line }] : [])) });

const TokenSpan = ({ token }: { token: HighlightToken }) => (
  <span className="dark:!text-[var(--shiki-dark)]" style={{ color: token.color, ...(token.htmlStyle as CSSProperties) }}>
    {token.content}
  </span>
);

const CodeBlockBody = memo(({ result, showLineNumbers }: { result: HighlightResult; showLineNumbers: boolean }) => (
  <pre className="m-0 overflow-x-auto p-3 font-mono text-xs leading-relaxed">
    <code className={cn(showLineNumbers && "[counter-reset:line]")}>
      {result.tokens.map((line, i) => (
        <span
          key={i}
          className={cn(
            "block",
            showLineNumbers &&
              "before:me-4 before:inline-block before:w-6 before:text-end before:text-fg-muted/60 before:content-[counter(line)] before:select-none before:[counter-increment:line]",
          )}
        >
          {line.length === 0 ? "\n" : line.map((token, j) => <TokenSpan key={j} token={token} />)}
        </span>
      ))}
    </code>
  </pre>
));
CodeBlockBody.displayName = "CodeBlockBody";

const CodeBlockContext = createContext({ code: "" });

export type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: string;
  showLineNumbers?: boolean;
};

/** Read-only code with syntax highlighting; children render as a header row (e.g. a copy button). */
export const CodeBlock = ({ code, language, showLineNumbers = false, className, children, ...props }: CodeBlockProps) => {
  const [result, setResult] = useState<HighlightResult>(() => highlight(code, language, () => {}) ?? plain(code));
  useEffect(() => {
    let live = true;
    const sync = highlight(code, language, (r) => live && setResult(r));
    setResult(sync ?? plain(code));
    return () => {
      live = false;
    };
  }, [code, language]);

  return (
    <CodeBlockContext.Provider value={{ code }}>
      <div
        className={cn("group relative w-full min-w-0 overflow-hidden rounded-lg border border-line bg-subtle/60 text-fg", className)}
        data-language={language}
        {...props}
      >
        {children && <div className="absolute end-1 top-1 z-10 flex items-center gap-1">{children}</div>}
        <CodeBlockBody result={result} showLineNumbers={showLineNumbers} />
      </div>
    </CodeBlockContext.Provider>
  );
};

export const CodeBlockCopyButton = ({ timeout = 2000, className }: { timeout?: number; className?: string }) => {
  const t = useT();
  const { code } = useContext(CodeBlockContext);
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <IconButton
      label={copied ? t.copied : t.copyCode}
      size="icon-sm"
      className={cn("bg-surface/80 text-fg-muted", className)}
      onClick={() =>
        void navigator.clipboard?.writeText(code).then(() => {
          setCopied(true);
          timer.current = window.setTimeout(() => setCopied(false), timeout);
        })
      }
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </IconButton>
  );
};
