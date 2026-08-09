import { Upload } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
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

export function FileUpload({ onChange }: { onChange?: (files: File[]) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = (list: File[]) => {
    const image = list.find((f) => f.type.startsWith("image/"));
    if (!image) return;
    const accepted = [image];
    setFiles(accepted);
    onChange?.(accepted);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload image"
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragActive(true);
      }}
      onDragLeave={() => setIsDragActive(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setIsDragActive(false);
        accept(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "group/file relative block w-full cursor-pointer select-none overflow-hidden rounded-lg p-10 transition-colors duration-200",
        isDragActive ? "bg-primary-soft/40 ring-2 ring-primary/40" : "bg-surface hover:bg-muted",
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

      <div className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,white,transparent)]">
        <GridPattern />
      </div>

      <div className="relative flex flex-col items-center">
        <p className="text-base font-semibold text-foreground">Upload image</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Drag or drop your files here or click to upload
        </p>

        <div className="relative mx-auto mt-8 w-full max-w-xl">
          {files.length > 0 && files[0] !== undefined ? (
            <div className="relative z-40 mx-auto w-full max-w-sm rounded-md bg-surface p-4 shadow-soft">
              <div className="flex items-center justify-between gap-4">
                <p className="max-w-xs truncate text-sm font-medium text-foreground">
                  {files[0].name}
                </p>
                <p className="w-fit shrink-0 rounded-lg bg-muted px-2 py-1 text-xs text-muted-foreground">
                  {(files[0].size / (1024 * 1024)).toFixed(2)} MB
                </p>
              </div>
              <p className="mt-2 w-fit rounded-md bg-muted px-1 py-0.5 text-xs text-muted-foreground">
                {files[0].type}
              </p>
            </div>
          ) : (
            <div
              className={cn(
                "relative z-40 mx-auto flex h-32 w-full max-w-[8rem] items-center justify-center rounded-md bg-surface shadow-soft transition-all duration-200 group-hover/file:shadow-lg",
                isDragActive && "-translate-y-2 translate-x-2",
              )}
            >
              {isDragActive ? (
                <p className="text-sm text-muted-foreground">Drop it</p>
              ) : (
                <Upload className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
          )}
          {files.length === 0 && (
            <div
              className={cn(
                "absolute inset-0 z-30 mx-auto flex h-32 w-full max-w-[8rem] items-center justify-center rounded-md border border-dashed border-primary/40 transition-opacity duration-200",
                isDragActive ? "opacity-100" : "opacity-0",
              )}
            ></div>
          )}
        </div>
      </div>
    </div>
  );
}

function GridPattern() {
  const columns = 41;
  const rows = 11;
  return (
    <svg className="absolute inset-0 h-full w-full text-muted-foreground/20" aria-hidden="true">
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
