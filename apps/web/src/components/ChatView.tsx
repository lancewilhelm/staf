import type { Message } from "@staf/protocol";
import { useEffect, useLayoutEffect, useRef } from "react";
import { chooseAgent, sendMessage, stopAnswer, useStore } from "../store.ts";
import { Composer } from "./Composer.tsx";
import { MessageView } from "./MessageView.tsx";

const EMPTY: Message[] = [];

export function ChatView() {
  const threadId = useStore((s) => s.threadId);
  const thread = useStore((s) => s.threads.find((t) => t.id === s.threadId) ?? null);
  const messages = useStore((s) => (s.threadId ? (s.messages[s.threadId] ?? EMPTY) : EMPTY));
  const running = thread?.status === "running" || messages.some((m) => m.status === "streaming");
  const agents = useStore((s) => s.agents);
  const agentId = useStore((s) => s.agentId);
  const threadAgent = agents.find((agent) => agent.id === thread?.agentId);

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the answer while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    pinned.current = true;
  }, [threadId]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (!threadId || (messages.length === 0 && !thread)) {
    return (
      <main className="chat empty">
        <div className="hero">
          <h1>What do you want to know?</h1>
          <Composer running={false} autoFocus onSend={(text) => void sendMessage(text)} onStop={() => {}} />
          {agents.length > 1 && (
            <div className="agent-picker" role="radiogroup" aria-label="Agent">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  role="radio"
                  aria-checked={agent.id === agentId}
                  className={`agent-chip${agent.id === agentId ? " selected" : ""}`}
                  onClick={() => chooseAgent(agent.id)}
                  title={agent.harnessLabel}
                >
                  <span>{agent.name}</span>
                  {!agent.harnessLabel.startsWith(agent.name) && (
                    <span className="agent-harness">{agent.harnessLabel}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="chat">
      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="column">
          {messages.map((message) => (
            <MessageView key={message.id} message={message} />
          ))}
        </div>
      </div>
      <div className="dock">
        <div className="column">
          <Composer
            running={running}
            autoFocus
            placeholder={threadAgent && agents.length > 1 ? `Ask ${threadAgent.name} a follow-up` : "Ask a follow-up"}
            onSend={(text) => void sendMessage(text)}
            onStop={() => void stopAnswer()}
          />
        </div>
      </div>
    </main>
  );
}
