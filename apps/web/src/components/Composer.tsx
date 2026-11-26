import { type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { formatFileSize } from "./Attachments.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  running: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  onSend: (text: string, files: File[]) => void;
  onStop: () => void;
}

export function Composer({ running, autoFocus, placeholder = "Ask anything", onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Grow with the text, up to a limit set in CSS.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const addFiles = (incoming: FileList | File[]) => {
    const list = Array.from(incoming).filter((file) => file.size > 0);
    if (list.length === 0) return;
    setFiles((current) => [...current, ...list]);
  };

  const removeFile = (index: number) => {
    setFiles((current) => current.filter((_, i) => i !== index));
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if ((!value && files.length === 0) || running) return;
    onSend(value, files);
    setText("");
    setFiles([]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData?.files;
    if (pasted && pasted.length > 0) addFiles(pasted);
  };

  const onDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
      setDragging(true);
    }
  };

  const onDragLeave = (event: DragEvent<HTMLFormElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
  };

  const canSend = text.trim().length > 0 || files.length > 0;

  return (
    <form
      className={`composer${dragging ? " dragging" : ""}`}
      onSubmit={submit}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {files.length > 0 && (
        <div className="composer-files" aria-label="Attached files">
          {files.map((file, index) => (
            <span key={`${file.name}-${file.size}-${index}`} className="composer-file">
              <Icon name="file" size={14} />
              <span className="composer-file-name" title={file.name}>
                {file.name}
              </span>
              <span className="composer-file-size">{formatFileSize(file.size)}</span>
              <button
                type="button"
                className="composer-file-remove"
                onClick={() => removeFile(index)}
                aria-label={`Remove ${file.name}`}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-input-row">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="composer-attach"
          onClick={() => fileInput.current?.click()}
          disabled={running}
          aria-label="Attach files"
          title="Attach files"
        >
          <Icon name="paperclip" size={18} />
        </button>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label="Message"
        />
        {running ? (
          <button type="button" className="composer-button stop" onClick={onStop} aria-label="Stop the answer">
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button type="submit" className="composer-button" disabled={!canSend} aria-label="Send">
            <Icon name="send" size={18} />
          </button>
        )}
      </div>
    </form>
  );
}
