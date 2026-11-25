import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";

interface Props {
  running: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ running, autoFocus, placeholder = "Ask anything", onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

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

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || running) return;
    onSend(value);
    setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Message"
      />
      {running ? (
        <button type="button" className="composer-button stop" onClick={onStop} aria-label="Stop the answer">
          <Icon name="stop" size={16} />
        </button>
      ) : (
        <button type="submit" className="composer-button" disabled={!text.trim()} aria-label="Send">
          <Icon name="send" size={18} />
        </button>
      )}
    </form>
  );
}
