"use client";

import { useLayoutEffect, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Feather,
  FileText,
  Image as ImageIcon,
  Link2,
  Mic,
  Paperclip,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { appConfig } from "@/config/app";
import { cn } from "@/lib/utils";

/**
 * The unified memory composer (Phase 9 §22–26).
 *
 * One calm question; several quiet ways to answer it. Text stays the
 * primary interaction — image, voice, file, and link are small doors
 * beside the field, not a dashboard of upload products. Drag a PDF in,
 * paste a screenshot, hum a note into the microphone: everything
 * converges into the same quiet "Saved." with honest, low-voiced
 * processing states. No AI language, ever.
 */

type InputStatus = "idle" | "saving" | "saved" | "error";

interface SavedSourceView {
  id: string;
  sourceType: string;
  extractionStatus: string;
  extractionError: string | null;
  label: string | null;
}

interface SavedOutcome {
  memoryId: string | null;
  sources: SavedSourceView[];
  notices: string[];
  deduplicated: boolean;
}

interface Attachment {
  kind: "image" | "audio" | "file" | "url";
  file: File | null;
  url: string | null;
  previewUrl: string | null;
  durationSeconds: number | null;
}

const ACCEPT = {
  image: "image/png,image/jpeg,image/webp,image/gif",
  audio: "audio/*",
  file: ".txt,.md,.markdown,.pdf,.docx",
} as const;

const QUIET_STATUS: Record<string, string> = {
  ready: "Ready",
  partial: "Partially processed",
  pending: "Waiting to be processed",
  processing: "Processing",
  failed: "Couldn't process",
};

export function MemoryInput({ className }: { className?: string }) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<InputStatus>("idle");
  const [outcome, setOutcome] = useState<SavedOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [urlEntryOpen, setUrlEntryOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [micNotice, setMicNotice] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestIdRef = useRef<string>(cryptoId());
  const router = useRouter();

  const hasContent = value.trim().length > 0;
  const busy = status === "saving";

  // Grow with the thought, gently. Cap keeps the page's composure.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  // Clean up object URLs and any live recording.
  useEffect(() => {
    return () => {
      if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function stopTimer(): void {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function cryptoId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function setAttach(next: Attachment | null): void {
    setAttachment((current) => {
      if (current?.previewUrl) URL.revokeObjectURL(current.previewUrl);
      return next;
    });
  }

  async function attachFromBlob(kind: Attachment["kind"], file: File, durationSeconds: number | null = null): Promise<void> {
    setUrlEntryOpen(false);
    setMicNotice(null);
    if (kind === "image") {
      setAttach({ kind, file, url: null, previewUrl: URL.createObjectURL(file), durationSeconds });
    } else {
      setAttach({ kind, file, url: null, previewUrl: null, durationSeconds });
    }
  }

  function classifyFile(file: File): Attachment["kind"] | null {
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("audio/")) return "audio";
    if (/\.(txt|md|markdown|pdf|docx)$/i.test(file.name)) return "file";
    return null;
  }

  async function attachFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    for (const file of list) {
      const kind = classifyFile(file);
      if (!kind) {
        setError("That file type isn't supported yet — text, Markdown, PDF, DOCX, images, and audio work.");
        setStatus("error");
        continue;
      }
      await attachFromBlob(kind, file);
    }
  }

  /* ——— Voice: record quietly, deliver as WAV ——— */

  async function startRecording(): Promise<void> {
    if (recording) return;
    setMicNotice(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        void finishRecording();
      };
      recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setMicNotice("The microphone isn't available right now — you can add a recording as a file instead.");
    }
  }

  function stopRecording(): void {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    stopTimer();
    setRecording(false);
  }

  async function finishRecording(): Promise<void> {
    const raw = new Blob(chunksRef.current);
    chunksRef.current = [];
    if (raw.size === 0) {
      setMicNotice("Nothing was recorded.");
      return;
    }
    let wav: Blob | null = null;
    try {
      wav = await blobToWav(raw);
    } catch {
      wav = null;
    }
    const ext = wav ? "wav" : raw.type.split("/")[1]?.split(";")[0] || "dat";
    const file = new File([wav ?? raw], `voice note.${ext}`, { type: wav ? "audio/wav" : raw.type || "audio/webm" });
    await attachFromBlob("audio", file, null);
  }

  /* ——— Keep: one door for every kind ——— */

  async function keep(): Promise<void> {
    if (busy) return;
    const isUrl = attachment?.kind === "url" && attachment.url;
    const hasFile = attachment && attachment.kind !== "url" && attachment.file;
    if (!hasContent && !hasFile && !isUrl) return;

    setStatus("saving");
    setError(null);
    setOutcome(null);
    const requestId = requestIdRef.current;
    requestIdRef.current = cryptoId();

    try {
      let response: Response;
      if (!hasFile && !isUrl) {
        // Typed text — the original quiet path, byte for byte.
        response = await fetch("/api/memories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ originalContent: value }),
        });
      } else {
        const form = new FormData();
        if (isUrl) {
          form.set("kind", "url");
          form.set("url", attachment!.url!);
        } else {
          form.set("kind", attachment!.kind);
          form.set("file", attachment!.file!);
        }
        if (hasContent) form.set("caption", value);
        form.set("requestId", requestId);
        if (attachment?.durationSeconds) form.set("durationSeconds", String(attachment.durationSeconds));
        response = await fetch("/api/ingest", { method: "POST", body: form });
      }
      const json = await response.json();

      if (!response.ok || !json.ok) {
        setError(json?.error?.message ?? "The memory could not be saved.");
        setStatus("error");
        return;
      }

      // Text path returns { memory }; ingestion returns the outcome.
      const data = json.data;
      const saved: SavedOutcome = data.memory
        ? {
            memoryId: data.memory.id,
            sources: [],
            notices: [],
            deduplicated: false,
          }
        : {
            memoryId: data.memoryId ?? null,
            sources: (data.sources ?? []) as SavedSourceView[],
            notices: (data.notices ?? []) as string[],
            deduplicated: Boolean(data.deduplicated),
          };

      setOutcome(saved);
      setValue("");
      setAttach(null);
      setUrlEntryOpen(false);
      setStatus("saved");
      router.refresh();
    } catch {
      setError("The memory could not be saved — the space is unreachable.");
      setStatus("error");
    }
  }

  async function retrySource(sourceId: string): Promise<void> {
    if (busy) return;
    setStatus("saving");
    setError(null);
    try {
      const response = await fetch(`/api/sources/${sourceId}/retry`, { method: "POST" });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        setError(json?.error?.message ?? "The retry could not finish.");
        setStatus("error");
        return;
      }
      setOutcome((current) => (current ? { ...current, ...(json.data ?? {}) } : json.data));
      setStatus("saved");
      router.refresh();
    } catch {
      setError("The retry could not finish — the space is unreachable.");
      setStatus("error");
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey && !attachment) {
      event.preventDefault();
      void keep();
    }
  }

  const failedSources = outcome?.sources.filter((s) => s.extractionStatus === "failed" || s.extractionStatus === "pending") ?? [];

  return (
    <div className={cn("w-full", className)}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void keep();
        }}
      >
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (event.dataTransfer.files.length > 0) void attachFiles(event.dataTransfer.files);
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length > 0) {
              event.preventDefault();
              void attachFiles(files);
            }
          }}
          className={cn(
            "rounded-xl border border-border bg-card shadow-xs transition-all duration-300",
            "focus-within:border-clay/40 focus-within:shadow-md focus-within:ring-4 focus-within:ring-clay/10",
            dragging && "border-clay/60 bg-clay-soft/40 ring-4 ring-clay/10"
          )}
        >
          <label htmlFor="memory-input" className="sr-only">
            {appConfig.memoryPrompt}
          </label>
          <textarea
            id="memory-input"
            ref={textareaRef}
            rows={2}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              if (status !== "idle" && status !== "saving") setStatus("idle");
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              attachment
                ? "Add a note about it — or keep it as it is"
                : appConfig.memoryPrompt
            }
            autoComplete="off"
            disabled={busy}
            className={cn(
              "block max-h-[220px] w-full resize-none bg-transparent px-5 pb-2 pt-4",
              "text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground/60",
              "focus:outline-none disabled:opacity-60"
            )}
          />

          {/* ——— The attachment, stated plainly ——— */}
          {attachment && !urlEntryOpen && (
            <div className="mx-4 mb-1 flex items-center gap-3 rounded-lg border border-border/70 bg-background/60 px-3 py-2">
              {attachment.kind === "image" && attachment.previewUrl ? (
                 
                <img
                  src={attachment.previewUrl}
                  alt="Preview of what you're keeping"
                  className="size-10 rounded-md border border-border/60 object-cover"
                />
              ) : (
                <span className="flex size-10 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground">
                  {attachment.kind === "audio" ? (
                    <Mic aria-hidden="true" className="size-4" />
                  ) : attachment.kind === "url" ? (
                    <Link2 aria-hidden="true" className="size-4" />
                  ) : (
                    <FileText aria-hidden="true" className="size-4" />
                  )}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-foreground">
                  {attachment.kind === "url" ? attachment.url : attachment.file?.name}
                </p>
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                  {attachment.kind === "image"
                    ? "Image"
                    : attachment.kind === "audio"
                      ? "Recording"
                      : attachment.kind === "url"
                        ? "Link"
                        : "File"}
                  {attachment.file ? ` · ${formatBytes(attachment.file.size)}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAttach(null)}
                disabled={busy}
                aria-label="Remove the attachment"
                className="rounded-md p-1.5 text-muted-foreground transition-colors duration-200 hover:bg-secondary hover:text-foreground"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </div>
          )}

          {/* ——— Link entry ——— */}
          {urlEntryOpen && (
            <div className="mx-4 mb-1 flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-3 py-2">
              <Link2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <input
                ref={urlInputRef}
                type="url"
                inputMode="url"
                placeholder="https://…"
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const url = urlInputRef.current?.value.trim();
                    if (url) setAttach({ kind: "url", file: null, url, previewUrl: null, durationSeconds: null });
                    setUrlEntryOpen(false);
                  }
                  if (event.key === "Escape") setUrlEntryOpen(false);
                }}
                className="h-7 w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setUrlEntryOpen(false)}
                aria-label="Close link entry"
                className="rounded-md p-1.5 text-muted-foreground transition-colors duration-200 hover:bg-secondary hover:text-foreground"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </div>
          )}

          {/* ——— Recording state ——— */}
          {recording && (
            <div className="mx-4 mb-1 flex items-center gap-3 rounded-lg border border-clay/40 bg-clay-soft/50 px-3 py-2">
              <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-clay" />
              <p className="flex-1 text-[13px] text-foreground">
                Listening… <span className="font-mono text-[12px] text-muted-foreground">{formatSeconds(recordSeconds)}</span>
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={stopRecording}
                className="h-7 gap-1.5 rounded-lg border-border bg-card px-2.5 text-[12px] text-muted-foreground"
              >
                <Square aria-hidden="true" className="size-3" />
                Stop
              </Button>
            </div>
          )}

          {micNotice && (
            <p role="status" className="px-5 pb-2 text-[12px] leading-relaxed text-muted-foreground">
              {micNotice}
            </p>
          )}

          <div className="flex items-center justify-between px-5 pb-3.5 pt-1">
            <div className="flex items-center gap-0.5">
              {/* Subtle doors beside the field — same product, other senses. */}
              <AttachButton
                label="Add an image"
                onClick={() => imageInputRef.current?.click()}
                disabled={busy || recording}
              >
                <ImageIcon aria-hidden="true" className="size-4" />
              </AttachButton>
              <AttachButton
                label="Record a voice note"
                onClick={() => (recording ? stopRecording() : void startRecording())}
                disabled={busy || Boolean(attachment)}
                active={recording}
              >
                <Mic aria-hidden="true" className="size-4" />
              </AttachButton>
              <AttachButton
                label="Attach a file"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || recording}
              >
                <Paperclip aria-hidden="true" className="size-4" />
              </AttachButton>
              <AttachButton
                label="Save a link"
                onClick={() => {
                  setAttach(null);
                  setUrlEntryOpen(true);
                }}
                disabled={busy || recording}
              >
                <Link2 aria-hidden="true" className="size-4" />
              </AttachButton>
              <span className="ml-2 hidden font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/50 lg:block">
                {attachment ? "Enter to keep · nothing uploads until you do" : "Enter to keep · Shift + Enter for a new line"}
              </span>
            </div>

            {(hasContent || attachment) && (
              <Button
                type="submit"
                size="sm"
                disabled={busy}
                className="h-8 animate-in gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground shadow-xs fade-in slide-in-from-bottom-1 duration-300"
              >
                <Feather aria-hidden="true" className="size-3.5" />
                {busy ? "Keeping…" : "Keep it"}
              </Button>
            )}
          </div>
        </div>
      </form>

      <input
        ref={imageInputRef}
        type="file"
        accept={ACCEPT.image}
        hidden
        onChange={(event) => {
          if (event.target.files?.[0]) void attachFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={audioInputRef}
        type="file"
        accept={ACCEPT.audio}
        hidden
        onChange={(event) => {
          if (event.target.files?.[0]) void attachFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT.file}
        hidden
        onChange={(event) => {
          if (event.target.files?.[0]) void attachFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {/* ——— The honest response ——— */}
      {status === "saved" && outcome && (
        <div
          role="status"
          className="mt-4 animate-in rounded-lg border-l-2 border-clay/60 bg-clay-soft/60 px-4 py-3 text-sm leading-relaxed text-accent-foreground fade-in slide-in-from-bottom-1 duration-500"
        >
          {outcome.memoryId ? (
            <p>
              Saved. It joins your archive —{" "}
              <Link
                href={`/memories/${outcome.memoryId}`}
                className="font-medium underline decoration-clay/50 underline-offset-2 hover:decoration-clay"
              >
                open it
              </Link>
              .
            </p>
          ) : (
            <p>Kept the original — there wasn&apos;t enough readable in it yet to make a memory. You can retry below.</p>
          )}

          {failedSources.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {failedSources.map((source) => (
                <li key={source.id} className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-clay/60" />
                  <span>
                    {QUIET_STATUS[source.extractionStatus] ?? "Processing"}
                    {source.extractionError ? ` — ${source.extractionError}` : ""}
                    {source.label ? ` (${source.label})` : ""}
                  </span>
                  <RetryButton onRetry={() => void retrySource(source.id)} />
                </li>
              ))}
            </ul>
          )}

          {outcome.notices.length > 0 && failedSources.length === 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {outcome.notices.map((notice) => (
                <li key={notice} className="text-[12px] text-muted-foreground">
                  {notice}
                </li>
              ))}
            </ul>
          )}

          {outcome.memoryId && (
            <p className="mt-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
              <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-clay/60" />
              Processing — this page will settle on its own
            </p>
          )}
        </div>
      )}

      {status === "error" && error && (
        <p
          role="alert"
          className="mt-4 animate-in fade-in slide-in-from-bottom-1 rounded-lg border-l-2 border-destructive/60 bg-destructive/5 px-4 py-3 text-sm leading-relaxed text-foreground duration-500"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function AttachButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "rounded-lg p-2 text-muted-foreground/70 transition-all duration-200",
        "hover:bg-secondary hover:text-foreground disabled:opacity-40",
        active && "bg-clay-soft/70 text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        setRetrying(true);
        onRetry();
        // The parent flips status; the label settles on the next render.
        setTimeout(() => setRetrying(false), 1200);
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground underline decoration-border underline-offset-4 transition-colors duration-200 hover:text-foreground hover:decoration-clay"
    >
      <RotateCcw aria-hidden="true" className={cn("size-3", retrying && "animate-spin")} />
      Try again
    </button>
  );
}

/* ——— Small client-side helpers ——— */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/**
 * Decode any browser recording into 16 kHz mono WAV — the format every
 * transcription backend accepts — using only browser primitives. If
 * decoding fails, the original blob is used and the server reacts
 * honestly to whatever it receives.
 */
async function blobToWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const targetRate = 16000;
    const channels = Math.min(1, decoded.numberOfChannels);
    const frames = Math.ceil(decoded.duration * targetRate);
    const buffer = ctx.createBuffer(channels, frames, targetRate);
    const source = decoded.getChannelData(0);
    const target = buffer.getChannelData(0);
    // Linear resample — deterministic, dependency-free, good enough for speech.
    const ratio = decoded.sampleRate / targetRate;
    for (let i = 0; i < frames; i++) {
      target[i] = source[Math.min(source.length - 1, Math.floor(i * ratio))] ?? 0;
    }
    return encodeWav(buffer);
  } finally {
    void ctx.close();
  }
}

function encodeWav(buffer: AudioBuffer): Blob {
  const channel = buffer.getChannelData(0);
  const bytesPerSample = 2;
  const dataLength = channel.length * bytesPerSample;
  const out = new ArrayBuffer(44 + dataLength);
  const view = new DataView(out);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (let i = 0; i < channel.length; i++) {
    const sample = Math.max(-1, Math.min(1, channel[i] ?? 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([out], { type: "audio/wav" });
}
