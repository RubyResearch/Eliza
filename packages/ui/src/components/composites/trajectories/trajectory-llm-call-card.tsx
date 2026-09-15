/**
 * Expandable card for one LLM call within a trajectory: model, latency, and
 * token metrics up top, then the system/input prompts and response rendered as
 * copyable TrajectoryCodeBlocks. The system prompt collapses independently.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";

import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Separator } from "../../ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { TrajectoryCodeBlock } from "./trajectory-code-block";

interface CallMetricProps {
  label: React.ReactNode;
  value: React.ReactNode;
  meta?: React.ReactNode;
}

function CallMetric({ label, value, meta }: CallMetricProps) {
  return (
    <Card variant="bottomDivider" className="px-3 py-3">
      <div className="text-xs text-[color:var(--settings-muted)]">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-[color:var(--settings-foreground)]">
        {value}
      </div>
      {meta ? (
        <div className="mt-1 truncate text-xs text-[color:var(--settings-muted)]">
          {meta}
        </div>
      ) : null}
    </Card>
  );
}

export interface TrajectoryLlmCallCardProps {
  /** Compact embedded inspectors already show model and usage in their summary. */
  compact?: boolean;
  callLabel: React.ReactNode;
  copyLabel: React.ReactNode;
  copyToClipboardLabel?: string;
  inputLabel: React.ReactNode;
  latencyLabel: React.ReactNode;
  latencyValue: React.ReactNode;
  maxLabel: React.ReactNode;
  maxValue: React.ReactNode;
  model: React.ReactNode;
  onCopy: (content: string) => void;
  outputLabel: React.ReactNode;
  purposeLabel: React.ReactNode;
  response: string;
  systemCollapseLabel: React.ReactNode;
  systemExpandLabel: React.ReactNode;
  systemLabel: React.ReactNode;
  systemLinesLabel: React.ReactNode;
  systemPrompt?: string | null;
  systemPromptButtonLabel: React.ReactNode;
  temperatureLabel: React.ReactNode;
  temperatureValue: React.ReactNode;
  tokensLabel: React.ReactNode;
  totalTokensValue: React.ReactNode;
  tokenBreakdownMeta: React.ReactNode;
  tags?: readonly string[];
  inputLinesLabel: React.ReactNode;
  outputLinesLabel: React.ReactNode;
  userPrompt: string;
}

export function TrajectoryLlmCallCard({
  compact = false,
  callLabel,
  copyLabel,
  copyToClipboardLabel,
  inputLabel,
  latencyLabel,
  latencyValue,
  maxLabel,
  maxValue,
  model,
  onCopy,
  outputLabel,
  purposeLabel,
  response,
  systemCollapseLabel,
  systemExpandLabel,
  systemLabel,
  systemLinesLabel,
  systemPrompt,
  systemPromptButtonLabel,
  temperatureLabel,
  temperatureValue,
  tokensLabel,
  totalTokensValue,
  tokenBreakdownMeta,
  tags,
  inputLinesLabel,
  outputLinesLabel,
  userPrompt,
}: TrajectoryLlmCallCardProps) {
  const [showSystem, setShowSystem] = React.useState(false);
  const purposeValue = tags?.length ? tags.join(", ") : "Inference";

  if (compact)
    return (
      <Tabs defaultValue="input" className="developer-call-text min-w-0">
        <TabsList aria-label="Model call text" className="h-auto">
          <TabsTrigger value="input" className="min-h-11">
            Input
          </TabsTrigger>
          <TabsTrigger value="output" className="min-h-11">
            Output
          </TabsTrigger>
          {systemPrompt ? (
            <TabsTrigger value="system" className="min-h-11">
              System
            </TabsTrigger>
          ) : null}
        </TabsList>
        {[
          { id: "input", label: "Input", content: userPrompt },
          { id: "output", label: "Output", content: response },
          ...(systemPrompt
            ? [{ id: "system", label: "System", content: systemPrompt }]
            : []),
        ].map((part) => (
          <TabsContent
            key={part.id}
            value={part.id}
            className="developer-raw-panel"
          >
            <TrajectoryCodeBlock
              compact
              label={part.label}
              content={part.content}
              linesLabel=""
              copyLabel={copyLabel}
              collapseLabel={systemCollapseLabel}
              expandLabel={systemExpandLabel}
              onCopy={onCopy}
            />
          </TabsContent>
        ))}
      </Tabs>
    );

  return (
    <section>
      <Separator tone="subtle40" />
      <div className="flex flex-col gap-4 pt-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-[color:var(--settings-muted)]">
              {callLabel}
            </div>
            <div className="text-lg font-semibold text-[color:var(--settings-foreground)]">
              {model}
            </div>
            {tags?.length ? (
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    size="compact"
                    tone="muted"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>

          {systemPrompt ? (
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={() => setShowSystem((current) => !current)}
              className="shrink-0 self-start"
            >
              {showSystem ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              {showSystem ? systemCollapseLabel : systemPromptButtonLabel}
            </Button>
          ) : null}
        </div>

        <div>
          <Separator tone="subtle40" />
          <div className="grid md:grid-cols-2 xl:grid-cols-5">
            <CallMetric
              label={purposeLabel}
              value={purposeValue}
              meta={callLabel}
            />
            <CallMetric
              label={latencyLabel}
              value={latencyValue}
              meta={outputLinesLabel}
            />
            <CallMetric
              label={tokensLabel}
              value={totalTokensValue}
              meta={tokenBreakdownMeta}
            />
            <CallMetric
              label={maxLabel}
              value={maxValue}
              meta={inputLinesLabel}
            />
            <CallMetric
              label={temperatureLabel}
              value={temperatureValue}
              meta={systemPrompt ? systemLinesLabel : systemExpandLabel}
            />
          </div>
        </div>

        {systemPrompt && showSystem ? (
          <TrajectoryCodeBlock
            content={systemPrompt}
            label={systemLabel}
            linesLabel={systemLinesLabel}
            copyLabel={copyLabel}
            copyToClipboardLabel={copyToClipboardLabel}
            collapseLabel={systemCollapseLabel}
            expandLabel={systemExpandLabel}
            onCopy={onCopy}
          />
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 min-[1000px]:grid-cols-2">
        <TrajectoryCodeBlock
          content={userPrompt}
          label={inputLabel}
          linesLabel={inputLinesLabel}
          copyLabel={copyLabel}
          copyToClipboardLabel={copyToClipboardLabel}
          collapseLabel={systemCollapseLabel}
          expandLabel={systemExpandLabel}
          onCopy={onCopy}
        />
        <TrajectoryCodeBlock
          content={response}
          label={outputLabel}
          linesLabel={outputLinesLabel}
          copyLabel={copyLabel}
          copyToClipboardLabel={copyToClipboardLabel}
          collapseLabel={systemCollapseLabel}
          expandLabel={systemExpandLabel}
          onCopy={onCopy}
        />
      </div>
    </section>
  );
}
