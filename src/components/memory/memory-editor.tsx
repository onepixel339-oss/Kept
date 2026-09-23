"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MEMORY_TYPES, type MemoryType } from "@/types/memory";
import { cn } from "@/lib/utils";

/**
 * MemoryEditor — editing stays honest: the user changes their own
 * words, and a meaningful edit quietly creates a version. Fields the
 * understanding pipeline gathered (a summary, a better title) show up
 * here like any other value — editable, replaceable, never mistaken
 * for the user's own words. No AI suggestions appear in the editor.
 */

export interface EditableMemory {
  id: string;
  title: string | null;
  originalContent: string;
  summary: string | null;
  memoryType: MemoryType;
  rememberedAt: string | null; // ISO
}

const TYPE_LABELS: Record<MemoryType, string> = {
  experience: "Experience",
  fact: "Fact",
  thought: "Thought",
  event: "Event",
  idea: "Idea",
  note: "Note",
  conversation: "Conversation",
};

export function MemoryEditor({ memory }: { memory: EditableMemory }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(memory.title ?? "");
  const [memoryType, setMemoryType] = useState<MemoryType>(memory.memoryType);
  const [rememberedAt, setRememberedAt] = useState(
    memory.rememberedAt ? memory.rememberedAt.slice(0, 10) : ""
  );
  const [content, setContent] = useState(memory.originalContent);
  const [summary, setSummary] = useState(memory.summary ?? "");
  const router = useRouter();

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/memories/${memory.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() === "" ? null : title.trim(),
          memoryType,
          rememberedAt: rememberedAt ? new Date(`${rememberedAt}T12:00:00`).toISOString() : null,
          originalContent: content,
          summary: summary.trim() === "" ? null : summary.trim(),
        }),
      });
      const json = await response.json();

      if (!response.ok || !json.ok) {
        setError(json?.error?.message ?? "The change could not be saved.");
        return;
      }

      setOpen(false);
      router.refresh();
    } catch {
      setError("The change could not be saved — the space is unreachable.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-8 gap-1.5 rounded-lg px-3 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <Pencil aria-hidden="true" className="size-3.5" />
        Edit
      </Button>
    );
  }

  return (
    <div
      className={cn(
        "w-full animate-in rounded-xl border border-border bg-card p-5 shadow-md fade-in slide-in-from-bottom-1 duration-300",
        "space-y-4"
      )}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="memory-title" className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Title
          </Label>
          <Input
            id="memory-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="A short title"
            className="border-border bg-background text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="memory-type" className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Type
            </Label>
            <Select value={memoryType} onValueChange={(value) => setMemoryType(value as MemoryType)}>
              <SelectTrigger id="memory-type" className="border-border bg-background text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMORY_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="memory-date" className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Remembered
            </Label>
            <Input
              id="memory-date"
              type="date"
              value={rememberedAt}
              onChange={(event) => setRememberedAt(event.target.value)}
              className="border-border bg-background text-sm"
            />
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="memory-content" className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          In your words
        </Label>
        <Textarea
          id="memory-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={5}
          className="min-h-28 resize-y border-border bg-background text-[15px] leading-relaxed"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="memory-summary" className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Summary <span className="normal-case tracking-normal text-muted-foreground/50">(yours — or gathered from your words)</span>
        </Label>
        <Textarea
          id="memory-summary"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          rows={2}
          className="min-h-16 resize-y border-border bg-background text-sm leading-relaxed"
        />
      </div>

      {error && (
        <p role="alert" className="rounded-lg border-l-2 border-destructive/60 bg-destructive/5 px-3 py-2 text-sm text-foreground">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="h-8 rounded-lg px-3 text-[13px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </Button>
        <Button
          onClick={() => void save()}
          disabled={saving || content.trim() === ""}
          size="sm"
          className="h-8 rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground shadow-xs"
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
