import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent
} from "react";
import { ArrowUp, CaretUpDown, Check, FileIcon, LockKeyhole, Paperclip, Square, UploadSimple, X } from "./icons";
import { AgentOrb } from "./aicss";
import { ReasoningEffort } from "./aicss/reasoning-effort";
import { HarnessMark } from "./harness-logos";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { shouldSubmitComposer } from "../mobileLayout";
import {
  appendAttachmentBlock,
  fileExtensionLabel,
  formatBytes,
  type MessageAttachment
} from "../messageAttachments";

// ---------------------------------------------------------------------------
// Model types (structural; App owns the full records)

export interface ComposerModelOption {
  id: string;
  label: string;
  values: Array<{ id: string; label: string; description?: string }>;
  defaultValue?: string;
}

export interface ComposerModel {
  id: string;
  label: string;
  description: string;
  badge?: string;
  options?: ComposerModelOption[];
}

export interface ComposerProvider {
  id: string;
  driver: string;
  display_name: string;
  /** Set for harness accounts added beside the default one. */
  account_label?: string | null;
  enabled: boolean;
  status: "ready" | "warning" | "error";
  models: ComposerModel[];
  defaultModel: string;
}

export interface ComposerSelection {
  providerInstanceId: string;
  model: string;
  options: Array<{ id: string; value: string | number | boolean }>;
}

export function selectionForModel(
  provider: Pick<ComposerProvider, "id">,
  model: ComposerModel,
  previous?: ComposerSelection | null
): ComposerSelection {
  return { providerInstanceId: provider.id, model: model.id, options: optionsForModel(model, previous?.options) };
}

export function optionsForModel(model: ComposerModel, previous: ComposerSelection["options"] = []): ComposerSelection["options"] {
  return (model.options ?? []).flatMap((option) => {
    const previousValue = previous.find((entry) => entry.id === option.id)?.value;
    const canReusePrevious = option.values.some((value) => value.id === String(previousValue));
    const value = canReusePrevious ? previousValue : (option.defaultValue ?? option.values[0]?.id);
    return value ? [{ id: option.id, value }] : [];
  });
}

const REASONING = "reasoningEffort";

// ---------------------------------------------------------------------------
// Attachments

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 12;
const MAX_IMAGE_EDGE = 2560;

interface PendingAttachment {
  key: string;
  name: string;
  size: number;
  mimeType: string;
  previewUrl: string | null;
  status: "uploading" | "ready" | "error";
  error?: string;
  attachment?: MessageAttachment;
}

async function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(blob);
  });
}

/** Large photos and screenshots are scaled down so agents get a sensible image. */
async function shrinkImage(file: File): Promise<Blob> {
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type) || typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const edge = Math.max(bitmap.width, bitmap.height);
    if (edge <= MAX_IMAGE_EDGE) {
      bitmap.close();
      return file;
    }
    const scale = MAX_IMAGE_EDGE / edge;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? file), type, 0.9));
  } catch {
    return file;
  }
}

async function uploadAttachment(file: File): Promise<MessageAttachment> {
  const blob = await shrinkImage(file);
  const response = await fetch("/api/attachments", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name || "pasted-image.png", mimeType: blob.type || file.type, data: await readAsBase64(blob) })
  });
  if (response.status === 413) throw new Error("Too large to upload (20 MB max).");
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      /* plain-text error */
    }
    throw new Error(message || "Upload failed.");
  }
  return ((await response.json()) as { attachment: MessageAttachment }).attachment;
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

// ---------------------------------------------------------------------------
// Composer

export function AgentComposer(props: {
  active: boolean;
  providers: ComposerProvider[];
  selection: ComposerSelection | null;
  harnessLocked?: boolean;
  message?: string;
  onMessageChange?: (message: string) => void;
  onSelectionChange: (selection: ComposerSelection) => Promise<void>;
  onSend: (message: string, selection: ComposerSelection) => Promise<void>;
  onCancel: () => Promise<void>;
  formatError?: (message: string) => string;
}) {
  const [internalMessage, setInternalMessage] = useState("");
  const message = props.message !== undefined ? props.message : internalMessage;
  const setMessage = props.onMessageChange ?? setInternalMessage;
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const messageRef = useRef(message);
  messageRef.current = message;

  useAutoGrow(textareaRef, message);

  // Free object URLs when the composer goes away.
  useEffect(() => () => attachmentsRef.current.forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl)), []);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    const room = MAX_ATTACHMENTS - attachmentsRef.current.length;
    if (room <= 0) {
      setError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    const accepted = files.slice(0, room);
    if (files.length > room) setError(`Only the first ${room} ${room === 1 ? "file was" : "files were"} added (limit ${MAX_ATTACHMENTS}).`);
    for (const file of accepted) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const tooLarge = file.size > MAX_FILE_BYTES && !file.type.startsWith("image/");
      const item: PendingAttachment = {
        key,
        name: file.name || "pasted-image.png",
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
        status: tooLarge ? "error" : "uploading",
        error: tooLarge ? "Larger than 20 MB" : undefined
      };
      setAttachments((current) => [...current, item]);
      if (tooLarge) continue;
      uploadAttachment(file).then(
        (attachment) =>
          setAttachments((current) => current.map((entry) => (entry.key === key ? { ...entry, status: "ready", attachment } : entry))),
        (uploadError: unknown) =>
          setAttachments((current) =>
            current.map((entry) =>
              entry.key === key
                ? { ...entry, status: "error", error: uploadError instanceof Error ? uploadError.message : "Upload failed" }
                : entry
            )
          )
      );
    }
    textareaRef.current?.focus();
  }, []);

  const removeAttachment = useCallback((key: string) => {
    setAttachments((current) => {
      const item = current.find((entry) => entry.key === key);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return current.filter((entry) => entry.key !== key);
    });
    textareaRef.current?.focus();
  }, []);

  // Files can be dropped anywhere on the chat pane, not just the input.
  useEffect(() => {
    const zone = formRef.current?.closest<HTMLElement>(".agent-chat-stage") ?? formRef.current;
    if (!zone) return;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragDepth((depth) => depth + 1);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      setDragDepth((depth) => Math.max(0, depth - 1));
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragDepth(0);
      addFiles(Array.from(event.dataTransfer?.files ?? []));
    };
    zone.addEventListener("dragenter", enter);
    zone.addEventListener("dragover", over);
    zone.addEventListener("dragleave", leave);
    zone.addEventListener("drop", drop);
    return () => {
      zone.removeEventListener("dragenter", enter);
      zone.removeEventListener("dragover", over);
      zone.removeEventListener("dragleave", leave);
      zone.removeEventListener("drop", drop);
    };
  }, [addFiles]);

  const uploading = attachments.some((item) => item.status === "uploading");
  const ready = attachments.filter((item) => item.status === "ready" && item.attachment);
  const canSend = Boolean(props.selection) && !sending && !uploading && (message.trim().length > 0 || ready.length > 0);

  async function submit() {
    if (!canSend || !props.selection) return;
    const sentText = message;
    const sentKeys = new Set(ready.map((item) => item.key));
    const text = appendAttachmentBlock(message.trim(), ready.map((item) => item.attachment!));
    setSending(true);
    setError(null);
    try {
      await props.onSend(text, props.selection);
      // Keep anything typed or attached while the send was in flight.
      if (messageRef.current === sentText) setMessage("");
      setAttachments((current) =>
        current.filter((item) => {
          if (!sentKeys.has(item.key)) return true;
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
          return false;
        })
      );
    } catch (sendError) {
      const raw = sendError instanceof Error ? sendError.message : "Failed to send message.";
      setError(props.formatError ? props.formatError(raw) : raw);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    if (!shouldSubmitComposer({ ...event, isComposing: event.nativeEvent.isComposing }, coarse)) return;
    event.preventDefault();
    void submit();
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  }

  return (
    <form
      ref={formRef}
      className={`cmp ${dragDepth > 0 ? "is-dragging" : ""} ${props.active ? "is-active" : ""}`}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="cmp-surface" onClick={(event) => event.target === event.currentTarget && textareaRef.current?.focus()}>
        {attachments.length > 0 ? <AttachmentTray items={attachments} onRemove={removeAttachment} /> : null}
        <textarea
          ref={textareaRef}
          className="cmp-input"
          value={message}
          rows={1}
          aria-label="Message the agent"
          placeholder={props.active ? "Steer the running turn…" : "Ask the agent to build, fix, or explain something…"}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="cmp-toolbar">
          <div className="cmp-toolbar-left">
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="cmp-icon-button" aria-label="Attach files" onClick={() => fileInputRef.current?.click()}>
                  <Paperclip size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Attach files · or drop / paste them</TooltipContent>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <ModelPicker
              providers={props.providers}
              selection={props.selection}
              harnessLocked={props.harnessLocked}
              onSelectionChange={props.onSelectionChange}
            />
          </div>
          <div className="cmp-toolbar-right">
            <span className="cmp-hint" aria-hidden="true">
              {props.active ? "↵ steer · ⇧↵ newline" : "↵ send · ⇧↵ newline"}
            </span>
            {props.active ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="cmp-stop" aria-label="Stop the turn" onClick={() => void props.onCancel()}>
                    <Square size={11} weight="fill" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Stop</TooltipContent>
              </Tooltip>
            ) : null}
            <button
              type="submit"
              className={`cmp-send ${canSend ? "is-ready" : ""}`}
              disabled={!canSend}
              aria-label={sending ? "Sending" : uploading ? "Waiting for uploads" : props.active ? "Send guidance" : "Send message"}
              title={uploading ? "Waiting for uploads to finish" : undefined}
            >
              {sending ? <AgentOrb variant="working" size={12} color="currentColor" /> : <ArrowUp size={15} weight="bold" />}
            </button>
          </div>
        </div>
        {dragDepth > 0 ? (
          <div className="cmp-drop" aria-hidden="true">
            <UploadSimple size={18} />
            <span>Drop files to attach</span>
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="cmp-error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}

function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    const max = Math.max(160, Math.round(window.innerHeight * 0.4));
    element.style.height = `${Math.min(element.scrollHeight, max)}px`;
    element.style.overflowY = element.scrollHeight > max ? "auto" : "hidden";
  }, [ref, value]);
}

const AttachmentTray = memo(function AttachmentTray({
  items,
  onRemove
}: {
  items: PendingAttachment[];
  onRemove: (key: string) => void;
}) {
  return (
    <div className="cmp-tray" role="list" aria-label="Attachments">
      {items.map((item) => (
        <div
          key={item.key}
          role="listitem"
          className={`cmp-tile is-${item.status} ${item.previewUrl ? "is-image" : ""}`}
          title={item.error ? `${item.name} — ${item.error}` : `${item.name} · ${formatBytes(item.size)}`}
        >
          {item.previewUrl ? (
            <img src={item.previewUrl} alt={item.name} />
          ) : (
            <span className="cmp-tile-file">
              <FileIcon size={14} />
              <span className="cmp-tile-name">{item.name}</span>
              <span className="cmp-tile-ext">{fileExtensionLabel(item.name)}</span>
            </span>
          )}
          {item.status === "uploading" ? (
            <span className="cmp-tile-overlay">
              <AgentOrb variant="working" size={14} color="#fff" />
            </span>
          ) : null}
          {item.status === "error" ? <span className="cmp-tile-overlay is-error">Failed</span> : null}
          <button type="button" className="cmp-tile-remove" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.key)}>
            <X size={10} weight="bold" />
          </button>
        </div>
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Model picker

const itemValue = (providerId: string, modelId: string) => `${providerId}::${modelId}`;

export function ModelPicker(props: {
  providers: ComposerProvider[];
  selection: ComposerSelection | null;
  harnessLocked?: boolean;
  onSelectionChange: (selection: ComposerSelection) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selection = props.selection;
  const provider = props.providers.find((entry) => entry.id === selection?.providerInstanceId) ?? props.providers[0];
  const model = provider?.models.find((entry) => entry.id === selection?.model) ?? provider?.models[0];
  const reasoningOption = model?.options?.find((option) => option.id === REASONING);
  const reasoningValue = String(
    selection?.options.find((option) => option.id === REASONING)?.value ?? reasoningOption?.defaultValue ?? ""
  );
  const reasoningLabel = reasoningOption?.values.find((value) => value.id === reasoningValue)?.label;

  const groups = useMemo(
    () =>
      props.providers.filter((entry) => entry.enabled && entry.models.length > 0 && (!props.harnessLocked || entry.id === provider?.id)),
    [props.providers, props.harnessLocked, provider?.id]
  );
  const [highlighted, setHighlighted] = useState(() => (provider && model ? itemValue(provider.id, model.id) : ""));
  useEffect(() => {
    if (open && provider && model) setHighlighted(itemValue(provider.id, model.id));
    if (!open) setQuery("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const [detailProviderId, detailModelId] = highlighted.split("::");
  const detailProvider = groups.find((entry) => entry.id === detailProviderId) ?? provider;
  const detailModel = detailProvider?.models.find((entry) => entry.id === detailModelId) ?? model;
  const detailIsSelected = detailProvider?.id === provider?.id && detailModel?.id === model?.id;

  function choose(nextProvider: ComposerProvider, nextModel: ComposerModel) {
    void props.onSelectionChange(selectionForModel(nextProvider, nextModel, selection));
    setOpen(false);
  }

  function setOption(optionId: string, value: string) {
    if (!selection || !provider || !model) return;
    // Changing effort on a model you're only previewing selects that model too.
    const base =
      detailIsSelected || !detailProvider || !detailModel ? selection : selectionForModel(detailProvider, detailModel, selection);
    const options = [...base.options.filter((option) => option.id !== optionId), { id: optionId, value }];
    void props.onSelectionChange({ ...base, options });
  }

  const detailOptions = detailModel?.options ?? [];
  const detailSelection = detailIsSelected ? selection : detailModel && detailProvider ? selectionForModel(detailProvider, detailModel, selection) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="cmp-model-trigger" aria-label="Choose a model" disabled={!provider}>
          {provider ? <HarnessMark driver={provider.driver} size={13} /> : null}
          <span className="cmp-model-name">{model?.label ?? selection?.model ?? "Choose model"}</span>
          {provider?.account_label ? <span className="cmp-model-account">{provider.account_label}</span> : null}
          {reasoningLabel ? <span className="cmp-model-effort">{reasoningLabel}</span> : null}
          <CaretUpDown size={11} className="cmp-model-caret" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="cmp-picker" side="top" align="start" sideOffset={10} aria-label="Choose a model">
        <Command value={highlighted} onValueChange={setHighlighted} loop>
          <div className="cmp-picker-list">
            <CommandInput value={query} onValueChange={setQuery} placeholder="Search models" />
            <CommandList>
              <CommandEmpty>No matching models.</CommandEmpty>
              {groups.map((group) => (
                <CommandGroup
                  key={group.id}
                  heading={
                    <span className="cmp-picker-heading">
                      <HarnessMark driver={group.driver} size={12} />
                      {group.display_name}
                      {props.harnessLocked ? <LockKeyhole size={11} /> : null}
                    </span>
                  }
                >
                  {group.models.map((entry) => {
                    const selected = group.id === provider?.id && entry.id === model?.id;
                    return (
                      <CommandItem
                        key={entry.id}
                        value={itemValue(group.id, entry.id)}
                        keywords={[entry.label, entry.id, group.display_name, entry.description]}
                        className={`cmp-picker-item ${selected ? "is-selected" : ""}`}
                        onSelect={() => choose(group, entry)}
                      >
                        <span className="cmp-picker-item-label">{entry.label}</span>
                        {entry.badge && entry.badge !== "Default" ? <span className="cmp-picker-badge">{entry.badge}</span> : null}
                        {selected ? <Check size={13} className="cmp-picker-check" /> : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
            {props.harnessLocked ? <div className="cmp-picker-note">The harness is fixed for this thread.</div> : null}
          </div>
        </Command>
        {detailModel && detailProvider ? (
          <div className="cmp-picker-detail" aria-live="polite">
            <div className="cmp-picker-detail-head">
              <HarnessMark driver={detailProvider.driver} size={14} />
              <span>{detailProvider.display_name}</span>
              {detailProvider.status !== "ready" ? <span className="cmp-picker-status">{detailProvider.status}</span> : null}
            </div>
            <strong className="cmp-picker-detail-title">{detailModel.label}</strong>
            <p className="cmp-picker-detail-desc">{detailModel.description || "No description from the harness."}</p>
            {detailOptions.map((option) => {
              const value = String(detailSelection?.options.find((entry) => entry.id === option.id)?.value ?? option.defaultValue ?? "");
              const active = option.values.find((entry) => entry.id === value);
              return (
                <div className="cmp-picker-option" key={option.id}>
                  <div className="cmp-picker-option-head">
                    <span>{option.label}</span>
                    <span className="cmp-picker-option-value">{active?.label ?? "—"}</span>
                  </div>
                  {option.id === REASONING && option.values.length > 1 ? (
                    <ReasoningEffort
                      levels={option.values}
                      value={value}
                      modelLabel={detailModel.label}
                      onChange={(next) => setOption(option.id, next)}
                    />
                  ) : (
                    <div className="cmp-segmented" role="radiogroup" aria-label={option.label}>
                      {option.values.map((entry) => (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={entry.id === value}
                          className={entry.id === value ? "is-active" : ""}
                          key={entry.id}
                          title={entry.description}
                          onClick={() => setOption(option.id, entry.id)}
                        >
                          {entry.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {active?.description ? <p className="cmp-picker-option-desc">{active.description}</p> : null}
                </div>
              );
            })}
            {!detailIsSelected ? (
              <button type="button" className="cmp-picker-use" onClick={() => choose(detailProvider, detailModel)}>
                Use {detailModel.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
