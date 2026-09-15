/**
 * The document-upload UI for `DocumentsView`: the `UploadZone` (file picker,
 * drag-drop, pasted-text, and URL ingestion) plus its scope controls. Upload
 * intents are handed back to the parent view's handlers; this file owns the
 * input surface, not the network call.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import type { DocumentScope } from "@elizaos/ui/api";
import { Button, Checkbox, Input, Textarea } from "@elizaos/ui/components";
import { useAppSelector } from "@elizaos/ui/state";
import {
  Bot,
  FileUp,
  Globe2,
  Link2,
  type LucideIcon,
  NotebookPen,
  Shield,
  User,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_DOCUMENT_UPLOAD_SCOPE,
  DOCUMENT_UPLOAD_ACCEPT,
  type DocumentUploadFile,
  type DocumentUploadOptions,
} from "./documents-upload.helpers";

const DOCUMENT_UPLOAD_SCOPE_OPTIONS: ReadonlyArray<{
  value: DocumentScope;
  labelKey: string;
  defaultLabel: string;
  titleKey: string;
  defaultTitle: string;
  Icon: LucideIcon;
}> = [
  {
    value: "user-private",
    labelKey: "documentsview.ScopeUser",
    defaultLabel: "User",
    titleKey: "documentsview.ScopeUserDescription",
    defaultTitle: "Visible to this user and the owner.",
    Icon: User,
  },
  {
    value: "global",
    labelKey: "documentsview.ScopeGlobal",
    defaultLabel: "Chat participants",
    titleKey: "documentsview.ScopeGlobalDescription",
    defaultTitle: "Shared within its chat. Not public on the internet.",
    Icon: Globe2,
  },
  {
    value: "owner-private",
    labelKey: "documentsview.ScopeOwner",
    defaultLabel: "Owner",
    titleKey: "documentsview.ScopeOwnerDescription",
    defaultTitle: "Owner-only document.",
    Icon: Shield,
  },
  {
    value: "agent-private",
    labelKey: "documentsview.ScopeAgent",
    defaultLabel: "Agent",
    titleKey: "documentsview.ScopeAgentDescription",
    defaultTitle: "Private to the agent runtime.",
    Icon: Bot,
  },
];

/* -- Scope selector button (registered for the agent surface) ------------- */

function ScopeButton({
  option,
  active,
  uploading,
  onSelect,
}: {
  option: (typeof DOCUMENT_UPLOAD_SCOPE_OPTIONS)[number];
  active: boolean;
  uploading: boolean;
  onSelect: (value: DocumentScope) => void;
}) {
  // Granular selector instead of useApp() so this only re-renders on locale
  // change, not on every app-store field (#9141 gap 2).
  const t = useAppSelector((s) => s.t);
  const { value, labelKey, defaultLabel, titleKey, defaultTitle, Icon } =
    option;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `documents-scope-${value}`,
    role: "tab",
    label: t(labelKey, { defaultValue: defaultLabel }),
    group: "documents-scope",
    status: active ? "active" : "inactive",
    description: t(titleKey, { defaultValue: defaultTitle }),
    onActivate: () => onSelect(value),
  });
  return (
    <Button
      ref={ref}
      aria-pressed={active}
      title={t(titleKey, { defaultValue: defaultTitle })}
      onClick={() => onSelect(value)}
      disabled={uploading}
      variant="selection"
      size="tiny"
      shape="circle"
      data-state={active ? "on" : "off"}
      // Borderless text tab (#10710): active = accent text on a faint wash,
      // matching DocumentsView's ScopeFilterChip so the two scope rows read as
      // one system (and the view stays under its border-density ceiling).
      {...agentProps}
    >
      <Icon className="size-3" aria-hidden />
      {t(labelKey, { defaultValue: defaultLabel })}
    </Button>
  );
}

/* -- Upload Zone ---------------------------------------------------------- */

export function UploadZone({
  fileInputId,
  onFilesUpload,
  onTextUpload,
  onUrlUpload,
  uploading,
  uploadStatus,
}: {
  fileInputId?: string;
  onFilesUpload: (
    files: DocumentUploadFile[],
    options: DocumentUploadOptions,
  ) => void;
  onTextUpload: (
    text: string,
    title: string | undefined,
    options: DocumentUploadOptions,
  ) => void;
  onUrlUpload: (url: string, options: DocumentUploadOptions) => void;
  uploading: boolean;
  uploadStatus: { current: number; total: number; filename: string } | null;
}) {
  const t = useAppSelector((s) => s.t);
  const [dragOver, setDragOver] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [textInput, setTextInput] = useState("");
  const [titleInput, setTitleInput] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [showTextInput, setShowTextInput] = useState(false);
  const [includeImageDescriptions, setIncludeImageDescriptions] =
    useState(true);
  const [selectedScope, setSelectedScope] = useState<DocumentScope>(
    DEFAULT_DOCUMENT_UPLOAD_SCOPE,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadOptions = useMemo<DocumentUploadOptions>(
    () => ({
      includeImageDescriptions,
      scope: selectedScope,
    }),
    [includeImageDescriptions, selectedScope],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLFieldSetElement>) => {
      event.preventDefault();
      // The DocumentsView root also accepts file drops (#10722); a drop inside
      // this zone must keep the zone's scoped options and never bubble up into
      // a second upload.
      event.stopPropagation();
      setDragOver(false);
      const files = Array.from(
        event.dataTransfer.files,
      ) as DocumentUploadFile[];
      if (files.length > 0 && !uploading) {
        onFilesUpload(files, uploadOptions);
      }
    },
    [onFilesUpload, uploadOptions, uploading],
  );

  const handleFileSelect = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0 && !uploading) {
        onFilesUpload(Array.from(files) as DocumentUploadFile[], uploadOptions);
      }
      event.target.value = "";
    },
    [onFilesUpload, uploadOptions, uploading],
  );

  const handleUrlSubmit = useCallback(() => {
    const url = urlInput.trim();
    if (url && !uploading) {
      onUrlUpload(url, uploadOptions);
      setUrlInput("");
      setShowUrlInput(false);
    }
  }, [onUrlUpload, uploadOptions, uploading, urlInput]);

  const handleTextSubmit = useCallback(() => {
    const text = textInput.trim();
    if (text && !uploading) {
      onTextUpload(text, titleInput.trim() || undefined, uploadOptions);
      setTextInput("");
      setTitleInput("");
      setShowTextInput(false);
    }
  }, [onTextUpload, textInput, titleInput, uploadOptions, uploading]);

  const chooseFilesButton = useAgentElement<HTMLButtonElement>({
    id: "documents-choose-files",
    role: "button",
    label: t("documentsview.ChooseFiles", { defaultValue: "Choose files" }),
    group: "documents-upload",
    description: "Open the file picker to upload documents",
    onActivate: () => fileInputRef.current?.click(),
  });
  const addUrlButton = useAgentElement<HTMLButtonElement>({
    id: "documents-add-url",
    role: "toggle",
    label: t("documentsview.AddFromURL", { defaultValue: "Add from URL" }),
    group: "documents-upload",
    status: showUrlInput ? "active" : "inactive",
    description: "Toggle the add-document-from-URL input",
    onActivate: () => setShowUrlInput((current) => !current),
  });
  const newTextButton = useAgentElement<HTMLButtonElement>({
    id: "documents-new-text",
    role: "toggle",
    label: t("documentsview.NewTextDocument", {
      defaultValue: "New text document",
    }),
    group: "documents-upload",
    status: showTextInput ? "active" : "inactive",
    description: "Toggle the new-text-document input",
    onActivate: () => setShowTextInput((current) => !current),
  });
  const urlInputField = useAgentElement<HTMLInputElement>({
    id: "documents-url-input",
    role: "text-input",
    label: t("documentsview.AddFromURL", { defaultValue: "Add from URL" }),
    group: "documents-upload",
    description: "URL of the document to import",
    getValue: () => urlInput,
    onFill: (value) => setUrlInput(value),
  });
  const urlSubmitButton = useAgentElement<HTMLButtonElement>({
    id: "documents-url-import",
    role: "button",
    label: t("settings.import"),
    group: "documents-upload",
    description: "Import the document from the entered URL",
    onActivate: () => handleUrlSubmit(),
  });
  const textTitleInput = useAgentElement<HTMLInputElement>({
    id: "documents-text-title",
    role: "text-input",
    label: t("documentsview.TitleOptional", {
      defaultValue: "Title (optional)",
    }),
    group: "documents-upload",
    description: "Optional title for the new text document",
    getValue: () => titleInput,
    onFill: (value) => setTitleInput(value),
  });
  const textBodyInput = useAgentElement<HTMLTextAreaElement>({
    id: "documents-text-body",
    role: "textarea",
    label: t("documentsview.PasteText", {
      defaultValue: "Paste knowledge text...",
    }),
    group: "documents-upload",
    description: "Body text of the new knowledge document",
    getValue: () => textInput,
    onFill: (value) => setTextInput(value),
  });
  const textSaveButton = useAgentElement<HTMLButtonElement>({
    id: "documents-text-save",
    role: "button",
    label: t("common.save", { defaultValue: "Save" }),
    group: "documents-upload",
    description: "Save the new text document",
    onActivate: () => handleTextSubmit(),
  });
  const imageDescriptionsCheckbox = useAgentElement<HTMLButtonElement>({
    id: "documents-image-descriptions",
    role: "toggle",
    label: t("documentsview.IncludeAIImageDes"),
    group: "documents-upload",
    status: includeImageDescriptions ? "active" : "inactive",
    description: "Whether to include AI image descriptions for uploads",
    onActivate: () => setIncludeImageDescriptions((current) => !current),
  });

  return (
    <fieldset
      className="w-full"
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      aria-label={t("aria.documentsUpload")}
    >
      <Input
        id={fileInputId}
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept={DOCUMENT_UPLOAD_ACCEPT}
        onChange={handleFileSelect}
      />
      {/* Flat at rest — the border/fill appears only as the drag-over drop-zone affordance. */}
      <div
        className={`rounded-sm border p-3 transition-colors ${
          dragOver ? "border-accent/40 bg-accent/8" : "border-transparent"
        } ${uploading ? "opacity-60" : ""}`}
      >
        <div className="flex items-center gap-2">
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              ref={chooseFilesButton.ref}
              variant="outline"
              size="icon"
              className="size-9"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label={t("documentsview.ChooseFiles", {
                defaultValue: "Choose files",
              })}
              title={t("documentsview.ChooseFiles", {
                defaultValue: "Choose files",
              })}
              {...chooseFilesButton.agentProps}
            >
              <FileUp className="size-4" />
            </Button>
            <Button
              ref={addUrlButton.ref}
              variant="choice"
              size="icon"
              data-state={showUrlInput ? "on" : "off"}
              onClick={() => setShowUrlInput((current) => !current)}
              disabled={uploading}
              aria-label={t("documentsview.AddFromURL", {
                defaultValue: "Add from URL",
              })}
              title={t("documentsview.AddFromURL", {
                defaultValue: "Add from URL",
              })}
              {...addUrlButton.agentProps}
            >
              <Link2 className="size-4" />
            </Button>
            <Button
              ref={newTextButton.ref}
              variant="choice"
              size="icon"
              data-state={showTextInput ? "on" : "off"}
              onClick={() => setShowTextInput((current) => !current)}
              disabled={uploading}
              aria-label={t("documentsview.NewTextDocument", {
                defaultValue: "New text document",
              })}
              title={t("documentsview.NewTextDocument", {
                defaultValue: "New text document",
              })}
              {...newTextButton.agentProps}
            >
              <NotebookPen className="size-4" />
            </Button>
          </div>
          <div className="min-w-0 flex-1 truncate text-xs-tight text-muted-strong">
            {uploadStatus
              ? t("documentsview.UploadingProgress", {
                  defaultValue: "Uploading {{current}}/{{total}}{{filename}}",
                  current: uploadStatus.current,
                  total: uploadStatus.total,
                  filename: uploadStatus.filename
                    ? `: ${uploadStatus.filename}`
                    : "",
                })
              : dragOver
                ? t("documentsview.DropFilesOrFoldersToUpload", {
                    defaultValue: "Drop files or folders to upload",
                  })
                : t("documentsview.DropFilesHereToUpload", {
                    defaultValue: "Drop files here to upload",
                  })}
          </div>
        </div>

        <fieldset className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0">
          <legend className="sr-only">
            {t("documentsview.ScopeSelectorLabel", {
              defaultValue: "Document scope",
            })}
          </legend>
          {DOCUMENT_UPLOAD_SCOPE_OPTIONS.map((option) => (
            <ScopeButton
              key={option.value}
              option={option}
              active={selectedScope === option.value}
              uploading={uploading}
              onSelect={setSelectedScope}
            />
          ))}
        </fieldset>

        {showUrlInput && (
          <div className="mt-3 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                ref={urlInputField.ref}
                type="url"
                placeholder={t("documentsview.httpsExampleCom")}
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                onKeyDown={(event) =>
                  event.key === "Enter" && handleUrlSubmit()
                }
                disabled={uploading}
                variant="document"
                className="flex-1"
                {...urlInputField.agentProps}
              />
              <Button
                ref={urlSubmitButton.ref}
                variant="default"
                size="formAction"
                onClick={handleUrlSubmit}
                disabled={!urlInput.trim() || uploading}
                {...urlSubmitButton.agentProps}
              >
                {t("settings.import")}
              </Button>
            </div>
          </div>
        )}

        {showTextInput && (
          <div className="mt-3 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="flex flex-col gap-2">
              <Input
                ref={textTitleInput.ref}
                type="text"
                placeholder={t("documentsview.TitleOptional", {
                  defaultValue: "Title (optional)",
                })}
                value={titleInput}
                onChange={(event) => setTitleInput(event.target.value)}
                disabled={uploading}
                variant="document"
                {...textTitleInput.agentProps}
              />
              <Textarea
                ref={textBodyInput.ref}
                placeholder={t("documentsview.PasteText", {
                  defaultValue: "Paste knowledge text...",
                })}
                value={textInput}
                onChange={(event) => setTextInput(event.target.value)}
                disabled={uploading}
                variant="document"
                density="document"
                {...textBodyInput.agentProps}
              />
              <Button
                ref={textSaveButton.ref}
                variant="default"
                size="formAction"
                className="self-end"
                onClick={handleTextSubmit}
                disabled={!textInput.trim() || uploading}
                {...textSaveButton.agentProps}
              >
                {t("common.save", { defaultValue: "Save" })}
              </Button>
            </div>
          </div>
        )}

        <div className="mt-3 inline-flex min-h-8 w-full items-center gap-2 text-2xs leading-relaxed text-muted">
          <Checkbox
            ref={imageDescriptionsCheckbox.ref}
            id="documents-upload-image-descriptions"
            checked={includeImageDescriptions}
            onCheckedChange={(checked: boolean | "indeterminate") =>
              setIncludeImageDescriptions(!!checked)
            }
            disabled={uploading}
            {...imageDescriptionsCheckbox.agentProps}
          />
          <label
            htmlFor="documents-upload-image-descriptions"
            className="inline-flex min-w-0 cursor-pointer items-center"
          >
            {t("documentsview.IncludeAIImageDes")}
          </label>
        </div>
      </div>
    </fieldset>
  );
}
