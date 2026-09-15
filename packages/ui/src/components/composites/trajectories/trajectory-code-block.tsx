/**
 * Labelled, copyable code block used across the trajectory viewer for prompt
 * and response payloads. Collapses to a preview past 20 lines with an
 * expand/collapse toggle and a copy-to-clipboard button.
 */
import * as React from "react";

import { Button } from "../../ui/button";
import { CodeBlock } from "../../ui/code-block";
import { PagePanel } from "../page-panel";

export interface TrajectoryCodeBlockProps {
  compact?: boolean;
  collapseLabel: React.ReactNode;
  content: string;
  copyLabel: React.ReactNode;
  copyToClipboardLabel?: string;
  expandLabel: React.ReactNode;
  label: React.ReactNode;
  linesLabel: React.ReactNode;
  onCopy: (content: string) => void;
}

export function TrajectoryCodeBlock({
  compact = false,
  collapseLabel,
  content,
  copyLabel,
  copyToClipboardLabel,
  expandLabel,
  label,
  linesLabel,
  onCopy,
}: TrajectoryCodeBlockProps) {
  const [expanded, setExpanded] = React.useState(false);
  const contentLines = React.useMemo(() => content.split("\n"), [content]);
  const lines = contentLines.length;
  const shouldTruncate = !expanded && lines > 20;
  const displayContent = shouldTruncate
    ? `${contentLines.slice(0, 20).join("\n")}\n...`
    : content;

  if (compact && content.length === 0)
    return (
      <p role="status" className="py-3 text-sm text-muted">
        Not recorded.
      </p>
    );
  if (compact)
    return (
      <div className="developer-code-block min-w-0 space-y-2">
        <p className="text-sm font-medium text-txt">{label}</p>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>
            {lines.toLocaleString()} {lines === 1 ? "line" : "lines"} ·{" "}
            {content.length.toLocaleString()} characters
          </span>
          <Button
            variant="outline"
            size="touch"
            type="button"
            onClick={() => onCopy(content)}
            aria-label={`Copy ${typeof label === "string" ? label : "content"}`}
          >
            {copyLabel}
          </Button>
        </div>
        <CodeBlock
          value={content}
          presentation="attachment"
          role="region"
          wrap
          tabIndex={0}
          aria-label={typeof label === "string" ? label : "Trajectory content"}
          className="developer-raw-text max-h-[50dvh] break-words p-3"
        />
      </div>
    );

  return (
    <PagePanel variant="inset" className="overflow-hidden">
      <PagePanel.Header
        heading={label}
        description={linesLabel}
        actions={
          <PagePanel.ActionRail className="p-1">
            {lines > 20 ? (
              <Button
                variant="outline"
                size="dense"
                type="button"
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded ? collapseLabel : expandLabel}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="dense"
              type="button"
              onClick={() => onCopy(content)}
              title={copyToClipboardLabel}
            >
              {copyLabel}
            </Button>
          </PagePanel.ActionRail>
        }
      />
      <CodeBlock
        value={displayContent}
        presentation="attachment"
        role="region"
        wrap
        tabIndex={0}
        aria-label={typeof label === "string" ? label : "Trajectory content"}
        className="max-h-112 break-words p-4"
      />
    </PagePanel>
  );
}
