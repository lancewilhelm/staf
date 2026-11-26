import type { Attachment } from "@staf/protocol";
import { useState } from "react";
import { Icon } from "./Icon.tsx";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_PREVIEW_MIMES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeLabel(attachment: Attachment): string {
  if (attachment.mimeType === "application/pdf") return "PDF";
  if (IMAGE_MIMES.has(attachment.mimeType)) return "Image";
  if (attachment.mimeType === "text/markdown") return "Markdown";
  if (attachment.mimeType === "text/csv") return "CSV";
  if (attachment.mimeType === "application/json") return "JSON";
  if (attachment.mimeType === "text/plain") return "Text";
  const dot = attachment.name.lastIndexOf(".");
  if (dot > 0 && dot < attachment.name.length - 1) return attachment.name.slice(dot + 1).toUpperCase();
  return "File";
}

export function Attachments({
  attachments,
  align = "left",
}: {
  attachments: Attachment[];
  align?: "left" | "right";
}) {
  if (attachments.length === 0) return null;
  return (
    <div className={`attachments${align === "right" ? " right" : ""}`}>
      {attachments.map((attachment) =>
        IMAGE_MIMES.has(attachment.mimeType) ? (
          <ImageAttachment key={attachment.id} attachment={attachment} />
        ) : (
          <FileAttachment key={attachment.id} attachment={attachment} />
        ),
      )}
    </div>
  );
}

function ImageAttachment({ attachment }: { attachment: Attachment }) {
  return (
    <figure className="attachment-image">
      <a href={attachment.url} target="_blank" rel="noopener noreferrer" title={`Open ${attachment.name}`}>
        <img src={attachment.url} alt={attachment.name} loading="lazy" />
      </a>
      <figcaption className="attachment-caption">
        <span className="attachment-name" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="attachment-size">{formatFileSize(attachment.sizeBytes)}</span>
        <a
          className="attachment-icon-link"
          href={`${attachment.url}?download=1`}
          download={attachment.name}
          aria-label={`Download ${attachment.name}`}
          title="Download"
        >
          <Icon name="download" size={14} />
        </a>
      </figcaption>
    </figure>
  );
}

function FileAttachment({ attachment }: { attachment: Attachment }) {
  const isPdf = attachment.mimeType === "application/pdf";
  const canOpenInline = isPdf || TEXT_PREVIEW_MIMES.has(attachment.mimeType);
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <div className={`attachment-card${previewOpen ? " expanded" : ""}`}>
      <div className="attachment-row">
        <span className="attachment-icon" aria-hidden="true">
          <Icon name="file" size={18} />
        </span>
        <div className="attachment-info">
          <span className="attachment-name" title={attachment.name}>
            {attachment.name}
          </span>
          <span className="attachment-meta">
            {fileTypeLabel(attachment)} · {formatFileSize(attachment.sizeBytes)}
          </span>
        </div>
        <div className="attachment-actions">
          {isPdf && (
            <button
              type="button"
              className="attachment-btn"
              aria-expanded={previewOpen}
              onClick={() => setPreviewOpen((open) => !open)}
            >
              {previewOpen ? "Hide" : "Preview"}
            </button>
          )}
          {canOpenInline && (
            <a
              className="attachment-icon-link"
              href={attachment.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${attachment.name}`}
              title="Open in new tab"
            >
              <Icon name="external" size={15} />
            </a>
          )}
          <a
            className="attachment-icon-link"
            href={`${attachment.url}?download=1`}
            download={attachment.name}
            aria-label={`Download ${attachment.name}`}
            title="Download"
          >
            <Icon name="download" size={15} />
          </a>
        </div>
      </div>
      {isPdf && previewOpen && (
        <div className="attachment-preview">
          <iframe className="attachment-pdf" src={attachment.url} title={attachment.name} />
        </div>
      )}
    </div>
  );
}
