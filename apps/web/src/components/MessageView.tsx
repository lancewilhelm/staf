import type { Message } from "@staf/protocol";
import { memo, useEffect, useMemo, useState } from "react";
import { renderMarkdown } from "../markdown.ts";
import { formatElapsedVerbose } from "../sidebar.ts";
import { Activities } from "./Activities.tsx";
import { Attachments } from "./Attachments.tsx";
import { Icon } from "./Icon.tsx";

export const MessageView = memo(function MessageView({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="message user">
        <div className="user-content">
          {message.attachments.length > 0 && <Attachments attachments={message.attachments} align="right" />}
          {message.text && <div className="bubble">{message.text}</div>}
        </div>
      </div>
    );
  }
  return <AssistantMessage message={message} />;
});

function useStreamingElapsed(active: boolean, startedAt: number): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  return active ? Math.max(0, now - startedAt) : undefined;
}

function AssistantMessage({ message }: { message: Message }) {
  const streaming = message.status === "streaming";
  const html = useMemo(() => renderMarkdown(message.text), [message.text]);
  const thinking = streaming && !message.text && !message.activities.some((a) => a.status === "running");
  const elapsedMs = useStreamingElapsed(streaming, message.createdAt);

  return (
    <div className="message assistant">
      <Activities
        activities={message.activities}
        streaming={streaming}
        startedAt={message.createdAt}
        completedAt={message.completedAt}
        elapsedMs={elapsedMs}
      />
      {thinking && (
        <div className="thinking-row">
          <div className="thinking" aria-label="Thinking">
            <span />
            <span />
            <span />
          </div>
          {elapsedMs !== undefined && elapsedMs >= 1000 && (
            <span className="thinking-time">{formatElapsedVerbose(elapsedMs)}</span>
          )}
        </div>
      )}
      {message.text && (
        <div className={`prose${streaming ? " streaming" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {message.attachments.length > 0 && <Attachments attachments={message.attachments} />}
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
