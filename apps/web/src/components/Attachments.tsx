import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_PER_MESSAGE, CLAUDE_READABLE_HINT, INLINE_IMAGE_TYPES, type Attachment } from '@shipyard/shared';
import { CircleAlert, Download, FileText, Paperclip, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { cn, formatBytes } from '../lib/utils';
import { Spinner } from './ui';

/**
 * Attaching files: a picker (paperclip, drag-and-drop, paste) that stages or
 * uploads files, and a list that renders posted attachments.
 */

export interface StagedFile {
  key: string;
  file: File;
  /** Object URL for image thumbnails. */
  preview: string | null;
  status: 'staged' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
  attachment?: Attachment;
}

let nextKey = 0;

/**
 * Files picked for one message or a new item. With `uploadTo`, each file
 * uploads to that item right away, as a draft by default (the discussion
 * composer must have ids ready before posting); without it, files wait in the
 * browser for `uploadAll` (the new-item dialog, before the item exists).
 */
export function useStagedFiles(opts: { uploadTo?: string; draft?: boolean; max?: number } = {}) {
  const { uploadTo, draft = true, max = ATTACHMENT_MAX_PER_MESSAGE } = opts;
  const [files, setFiles] = useState<StagedFile[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;

  const update = (key: string, patch: Partial<StagedFile>) => setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const upload = useCallback(async (s: StagedFile, itemId: string, draft: boolean) => {
    update(s.key, { status: 'uploading', progress: 0, error: undefined });
    try {
      const attachment = await api.uploadAttachment(itemId, s.file, { draft, onProgress: (progress) => update(s.key, { progress }) });
      update(s.key, { status: 'done', progress: 1, attachment });
      return true;
    } catch (err) {
      update(s.key, { status: 'error', error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }, []);

  const add = useCallback(
    (list: FileList | File[]) => {
      const incoming = Array.from(list);
      const room = max - filesRef.current.length;
      if (incoming.length > room) toast.error(`You can attach up to ${max} files at a time`);
      const accepted: StagedFile[] = [];
      for (const file of incoming.slice(0, Math.max(room, 0))) {
        if (file.size > ATTACHMENT_MAX_BYTES) {
          toast.error(`${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(ATTACHMENT_MAX_BYTES)}`);
          continue;
        }
        const preview = INLINE_IMAGE_TYPES.includes(file.type) ? URL.createObjectURL(file) : null;
        accepted.push({ key: `f${nextKey++}`, file, preview, status: 'staged', progress: 0 });
      }
      if (!accepted.length) return;
      setFiles((prev) => [...prev, ...accepted]);
      if (uploadTo) for (const s of accepted) void upload(s, uploadTo, draft);
    },
    [uploadTo, draft, max, upload],
  );

  const remove = (key: string) => {
    const f = filesRef.current.find((x) => x.key === key);
    if (!f) return;
    if (f.preview) URL.revokeObjectURL(f.preview);
    // Removing a chip undoes its upload.
    if (f.attachment) void api.deleteAttachment(f.attachment.id).catch(() => undefined);
    setFiles((prev) => prev.filter((x) => x.key !== key));
  };

  /** Clear after posting: the files now belong to the message, so nothing is deleted. */
  const reset = () => {
    for (const f of filesRef.current) if (f.preview) URL.revokeObjectURL(f.preview);
    setFiles([]);
  };

  /** Upload staged files one by one as item attachments; returns how many failed. */
  const uploadAll = async (itemId: string): Promise<number> => {
    let failed = 0;
    for (const f of filesRef.current) {
      if (f.status === 'done') continue;
      if (!(await upload(f, itemId, false))) failed++;
    }
    return failed;
  };

  useEffect(() => () => filesRef.current.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), []);

  return {
    files,
    add,
    remove,
    reset,
    uploadAll,
    uploading: files.some((f) => f.status === 'uploading'),
    failed: files.some((f) => f.status === 'error'),
    ids: files.flatMap((f) => (f.status === 'done' && f.attachment ? [f.attachment.id] : [])),
  };
}

export type StagedFiles = ReturnType<typeof useStagedFiles>;

/** Drag-and-drop onto any element, plus a highlight while dragging over it. */
export function useFileDrop(add: (files: FileList) => void) {
  const [over, setOver] = useState(false);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        add(e.dataTransfer.files);
      },
    },
  };
}

/** For textareas: pasting a screenshot attaches it instead of inserting nothing. */
export function pasteFiles(add: (files: File[]) => void) {
  return (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (!files.length) return;
    e.preventDefault();
    add(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}${i ? `-${i}` : ''}.png`, { type: f.type }))));
  };
}

/** Paperclip button, the staged files as chips, and which formats Claude can read. */
export function AttachmentPicker({ staged, className, hint = true }: { staged: StagedFiles; className?: string; hint?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={cn('space-y-2', className)}>
      {staged.files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {staged.files.map((f) => (
            <li
              key={f.key}
              className={cn(
                'relative flex max-w-60 items-center gap-2 overflow-hidden rounded-lg border bg-raised py-1 pr-1 pl-1.5 text-xs',
                f.status === 'error' ? 'border-rose-500/40 text-rose-400' : 'border-line text-muted',
              )}
              title={f.error ?? `${f.file.name} · ${formatBytes(f.file.size)}`}
            >
              {f.preview ? <img src={f.preview} alt="" className="size-7 shrink-0 rounded object-cover" /> : <FileText className="size-4 shrink-0 text-faint" />}
              <span className="min-w-0">
                <span className="block truncate text-fg">{f.file.name}</span>
                <span className="block text-[10px] text-faint">{f.status === 'error' ? (f.error ?? 'Upload failed') : formatBytes(f.file.size)}</span>
              </span>
              {f.status === 'uploading' && <Spinner className="size-3 shrink-0" />}
              {f.status === 'error' && <CircleAlert className="size-3.5 shrink-0" />}
              <button type="button" onClick={() => staged.remove(f.key)} className="shrink-0 rounded p-0.5 text-faint hover:text-fg" title="Remove">
                <X className="size-3.5" />
              </button>
              {f.status === 'uploading' && <span className="absolute bottom-0 left-0 h-0.5 bg-accent transition-all" style={{ width: `${Math.round(f.progress * 100)}%` }} />}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-raised hover:text-fg"
          title={`Attach files (up to ${formatBytes(ATTACHMENT_MAX_BYTES)} each). You can also drop or paste them.`}
        >
          <Paperclip className="size-3.5" />
          Attach
        </button>
        {hint && <span className="text-[11px] text-faint">{CLAUDE_READABLE_HINT}</span>}
      </div>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) staged.add(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/** Posted attachments: images as thumbnails that open full size, other files as download rows. */
export function AttachmentList({ attachments, onDelete, className }: { attachments: Attachment[]; onDelete?: (a: Attachment) => void; className?: string }) {
  if (!attachments.length) return null;
  const images = attachments.filter((a) => a.isImage);
  const others = attachments.filter((a) => !a.isImage);
  return (
    <div className={cn('space-y-2', className)}>
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {images.map((a) => (
            <li key={a.id} className="group/att relative">
              <a href={a.url} target="_blank" rel="noreferrer" title={`${a.filename} · ${formatBytes(a.size)}`}>
                <img src={a.url} alt={a.filename} loading="lazy" className="h-24 max-w-48 rounded-lg border border-line bg-raised object-cover hover:border-accent" />
              </a>
              {onDelete && (
                <button
                  onClick={() => onDelete(a)}
                  className="absolute top-1 right-1 rounded-md bg-bg/80 p-1 text-faint opacity-0 group-hover/att:opacity-100 hover:text-rose-400"
                  title="Delete attachment"
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="space-y-1">
          {others.map((a) => (
            <li key={a.id} className="group/att flex items-center gap-2 rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs">
              <FileText className="size-3.5 shrink-0 text-faint" />
              <a href={a.url} download={a.filename} className="min-w-0 flex-1 truncate text-fg hover:underline" title={a.mimeType}>
                {a.filename}
              </a>
              <span className="shrink-0 text-faint">{formatBytes(a.size)}</span>
              <a href={a.url} download={a.filename} className="shrink-0 rounded p-0.5 text-faint hover:text-fg" title="Download">
                <Download className="size-3.5" />
              </a>
              {onDelete && (
                <button onClick={() => onDelete(a)} className="shrink-0 rounded p-0.5 text-faint opacity-0 group-hover/att:opacity-100 hover:text-rose-400" title="Delete attachment">
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
