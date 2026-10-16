import { ImagePlus, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { cn } from "@/lib/utils";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_EDGE = 512;

export function readImageDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Choose an image file."));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error("Image must be under 5MB."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(src);
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("Couldn't read that image."));
      img.src = src;
    };
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function FileUpload({ onChange }: { onChange?: (files: File[]) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const file = files[0];

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const accept = (list: File[]) => {
    const image = list.find((f) => f.type.startsWith("image/"));
    if (!image) return;
    const accepted = [image];
    setFiles(accepted);
    onChange?.(accepted);
  };

  const clear = () => {
    setFiles([]);
    onChange?.([]);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload image"
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragActive(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setIsDragActive(false);
        }
      }}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setIsDragActive(false);
        accept(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "group/file relative block w-full cursor-pointer select-none overflow-hidden rounded-2xl border border-dashed p-10 outline-none transition-all duration-300",
        "focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2",
        isDragActive
          ? "scale-[1.01] border-primary/60 bg-primary-soft/40 shadow-lg ring-4 ring-primary/10"
          : "border-muted-foreground/25 bg-surface hover:border-primary/40 hover:bg-muted/60",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          accept(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />

      {/* Ambient glow */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-1/2 top-0 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/20 blur-3xl transition-opacity duration-500",
          isDragActive ? "opacity-100" : "opacity-0 group-hover/file:opacity-60",
        )}
      />

      {/* Dot grid */}
      <div className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,white,transparent_75%)]">
        <GridPattern />
      </div>

      <div className="relative flex flex-col items-center text-center">
        {file && previewUrl ? (
          <div className="flex w-full max-w-sm flex-col items-center gap-5 animate-in fade-in zoom-in-95 duration-300">
            <div className="relative">
              <div className="absolute -inset-2 rounded-3xl bg-gradient-to-br from-primary/30 via-primary/5 to-transparent blur-md" />
              <img
                src={previewUrl}
                alt={file.name}
                className="relative h-32 w-32 rounded-2xl object-cover shadow-soft ring-1 ring-black/5"
              />
              <button
                type="button"
                aria-label="Remove image"
                onClick={(e) => {
                  e.stopPropagation();
                  clear();
                }}
                className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full bg-surface text-muted-foreground shadow-soft ring-1 ring-black/5 transition hover:scale-110 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="w-full space-y-2">
              <p className="truncate text-sm font-semibold text-foreground">{file.name}</p>
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-full bg-muted px-2.5 py-1">{formatSize(file.size)}</span>
                <span className="rounded-full bg-muted px-2.5 py-1">
                  {file.type.replace("image/", "").toUpperCase()}
                </span>
              </div>
              <p className="pt-1 text-xs text-muted-foreground">Click or drop another image to replace</p>
            </div>
          </div>
        ) : (
          <>
            {/* Stacked-card icon */}
            <div className="relative h-24 w-28">
              <div
                className={cn(
                  "absolute inset-0 m-auto h-20 w-20 rounded-2xl bg-muted shadow-soft transition-all duration-300",
                  isDragActive ? "-rotate-12 -translate-x-4" : "-rotate-6 -translate-x-2 group-hover/file:-rotate-12 group-hover/file:-translate-x-3",
                )}
              />
              <div
                className={cn(
                  "absolute inset-0 m-auto h-20 w-20 rounded-2xl bg-muted shadow-soft transition-all duration-300",
                  isDragActive ? "rotate-12 translate-x-4" : "rotate-6 translate-x-2 group-hover/file:rotate-12 group-hover/file:translate-x-3",
                )}
              />
              <div
                className={cn(
                  "absolute inset-0 m-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-surface shadow-soft ring-1 ring-black/5 transition-all duration-300",
                  isDragActive ? "-translate-y-2 scale-110" : "group-hover/file:-translate-y-1",
                )}
              >
                {isDragActive ? (
                  <Upload className="h-7 w-7 text-primary" />
                ) : (
                  <ImagePlus className="h-7 w-7 text-primary/80" />
                )}
              </div>
            </div>

            <p className="mt-6 text-base font-semibold tracking-tight text-foreground">
              {isDragActive ? "Drop to upload" : "Upload image"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Drag and drop your image here, or{" "}
              <span className="font-medium text-primary underline-offset-4 group-hover/file:underline">
                browse
              </span>
            </p>
            <p className="mt-4 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
              PNG, JPG or WebP · up to 5MB
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function GridPattern() {
  const columns = 41;
  const rows = 11;
  return (
    <svg className="absolute inset-0 h-full w-full text-muted-foreground/25" aria-hidden="true">
      {Array.from({ length: rows }).map((_, row) =>
        Array.from({ length: columns }).map((_, col) => {
          const index = row * columns + col;
          return (
            <circle
              key={index}
              cx={10 + col * 16}
              cy={10 + row * 16}
              r="1.5"
              fill={index % 4 === 0 ? "currentColor" : "transparent"}
            />
          );
        }),
      )}
    </svg>
  );
}
