/**
 * Test stub for @elizaos/ui: lightweight semantic controls, inert components,
 * and an empty ElizaClient let LifeOps tests exercise accessibility and event
 * behavior without loading the production UI runtime.
 */
import {
  type ButtonHTMLAttributes,
  type ChangeEvent,
  Children,
  createElement,
  Fragment,
  type InputHTMLAttributes,
  isValidElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

type ComponentProps = Record<string, unknown>;

function NullComponent(_props: ComponentProps): null {
  return null;
}

function PassthroughComponent(props: { children?: ReactNode }): ReactNode {
  return createElement(Fragment, null, props.children);
}

function TestAlert({ children }: { children?: ReactNode }): ReactNode {
  return createElement("div", { role: "alert" }, children);
}

function TestAlertDescription({
  children,
}: {
  children?: ReactNode;
}): ReactNode {
  return createElement("div", null, children);
}

export class ElizaClient {}

export const client = new ElizaClient();

function TestButton({
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): ReactNode {
  return createElement(
    "button",
    { ...props, type: props.type ?? "button" },
    children,
  );
}

function TestCheckbox({
  onCheckedChange,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  onCheckedChange?: (checked: boolean) => void;
}): ReactNode {
  return createElement("input", {
    ...props,
    type: "checkbox",
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      props.onChange?.(event);
      onCheckedChange?.(event.currentTarget.checked);
    },
  });
}

function TestSelect({
  children,
  onValueChange,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  onValueChange?: (value: string) => void;
}): ReactNode {
  const trigger = Children.toArray(children).find(
    (child) => isValidElement(child) && child.type === TestSelectTrigger,
  );
  const id = isValidElement<{ id?: string }>(trigger)
    ? trigger.props.id
    : undefined;
  return createElement(
    "select",
    {
      ...props,
      id,
      onChange: (event: ChangeEvent<HTMLSelectElement>) => {
        props.onChange?.(event);
        onValueChange?.(event.currentTarget.value);
      },
    },
    children,
  );
}

function TestSelectTrigger(_props: ComponentProps): null {
  return null;
}

function TestSelectItem({
  children,
  value,
}: {
  children?: ReactNode;
  value?: string;
}): ReactNode {
  return createElement("option", { value }, children);
}

function TestSegmentedControl({
  value,
  onValueChange,
  items,
  ...props
}: {
  value: string;
  onValueChange: (value: string) => void;
  items: Array<{ value: string; label: ReactNode; disabled?: boolean }>;
  className?: string;
}): ReactNode {
  return createElement(
    "div",
    props,
    items.map((item) =>
      createElement(
        "button",
        {
          key: item.value,
          type: "button",
          disabled: item.disabled,
          "aria-pressed": value === item.value,
          onClick: () => onValueChange(item.value),
        },
        item.label,
      ),
    ),
  );
}

// Lifecycle constants + platform probes the activity-signal capture imports at
// module scope; the capture only calls them once a renderer-service host
// starts it, so inert values are enough for import-time linking.
export const APP_PAUSE_EVENT = "eliza:app-pause";
export const APP_RESUME_EVENT = "eliza:app-resume";

export function isAuthenticatedNow(): boolean {
  return true;
}

export function subscribeAuthStatus(): () => void {
  return () => {};
}

export function isElectrobunRuntime(): boolean {
  return false;
}

export async function loadDesktopWorkspaceSnapshot(): Promise<{
  supported: boolean;
}> {
  return { supported: false };
}

export const Badge = PassthroughComponent;
export const Alert = TestAlert;
export const AlertDescription = TestAlertDescription;
export const AlertTitle = PassthroughComponent;
export const Button = TestButton;
export const Card = PassthroughComponent;
export const Checkbox = TestCheckbox;
export const Input = (
  props: InputHTMLAttributes<HTMLInputElement>,
): ReactNode => createElement("input", props);
export const NativeSelect = (
  props: SelectHTMLAttributes<HTMLSelectElement>,
): ReactNode => createElement("select", props);
export const PagePanel = PassthroughComponent;
export const Select = TestSelect;
export const SelectContent = PassthroughComponent;
export const SelectItem = TestSelectItem;
export const SelectTrigger = TestSelectTrigger;
export const SelectValue = NullComponent;
export const SegmentedControl = TestSegmentedControl;
export const Switch = NullComponent;
export const Textarea = (
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
): ReactNode => createElement("textarea", props);
export const TooltipHint = PassthroughComponent;
export const TooltipProvider = PassthroughComponent;

export function useAgentElement(): Record<string, unknown> {
  return { ref: { current: null }, agentProps: {} };
}

export function useApp(): Record<string, unknown> {
  return {};
}

export function useChatComposer(): Record<string, unknown> {
  return {};
}

export function dispatchFocusConnector(): void {}

export function isApiError(): boolean {
  return false;
}

export function isElizaOS(): boolean {
  return false;
}

export function openExternalUrl(): void {}

export function registerBuiltinWidgetDeclarations(): void {}

export function registerBuiltinWidgets(): void {}

export function registerAppShellPage(): void {}

export function registerOverlayApp(): void {}

export function getAppBlockerPlugin(): Record<string, unknown> {
  return {};
}

export {
  RadioGroup,
  RadioGroupItem,
} from "../../../../packages/ui/src/components/ui/radio-group.js";
