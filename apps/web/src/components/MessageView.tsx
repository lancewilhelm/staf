import type { Message } from "@staf/protocol";
import { memo, useMemo } from "react";
import { renderMarkdown } from "../markdown.ts";
import { Activities } from "./Activities.tsx";
import { Icon } from "./Icon.tsx";

export const MessageView = memo(function MessageView({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="message user">
        <div className="bubble">{message.text}</div>
      </div>
    );
  }
  return <AssistantMessage message={message} />;
});

function AssistantMessage({ message }: { message: Message }) {
  const streaming = message.status === "streaming";
  const html = useMemo(() => renderMarkdown(message.text), [message.text]);
  const thinking = streaming && !message.text && !message.activities.some((a) => a.status === "running");

  return (
    <div className="message assistant">
      <Activities activities={message.activities} streaming={streaming} />
      {thinking && (
        <div className="thinking" aria-label="Thinking">
          <span />
          <span />
          <span />
        </div>
      )}
      {message.text && (
        <div className={`prose${streaming ? " streaming" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {message.status === "failed" && (
        <div className="notice error">
          <Icon name="alert" size={16} />
          <span>{message.error ?? "Staf could not answer."}</span>
        </div>
      )}
      {message.status === "interrupted" && <div className="stopped">{message.error ?? "Stopped"}</div>}
    </div>
  );
}
