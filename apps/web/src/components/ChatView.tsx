import type { Message } from "@staf/protocol";
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { modelName, sendMessage, stopAnswer, useStore, useHarnesses } from "../store.ts";
import { ChatPill } from "./ChatPill.tsx";
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
  const currentAgent = agents.find((agent) => agent.id === (thread?.agentId ?? agentId)) ?? null;

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
          {agents.length > 1 && currentAgent && <p className="hero-agent">{currentAgent.name}</p>}
          <h1>What do you want to know?</h1>
          <Composer
            running={false}
            autoFocus
            placeholder={agents.length > 1 && currentAgent ? `Ask ${currentAgent.name}` : "Ask anything"}
            onSend={(text) => void sendMessage(text)}
            onStop={() => {}}
          />
          <div className="composer-meta">
            <ChatPill direction="down" />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="chat">
      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="column">
          {messages.map((message, index) => (
            <Fragment key={message.id}>
              <Switch messages={messages} index={index} />
              <MessageView message={message} />
            </Fragment>
          ))}
        </div>
      </div>
      <div className="dock">
        <div className="column">
          <Composer
            running={running}
            autoFocus
            placeholder={currentAgent && agents.length > 1 ? `Ask ${currentAgent.name} a follow-up` : "Ask a follow-up"}
            onSend={(text) => void sendMessage(text)}
            onStop={() => void stopAnswer()}
          />
          <div className="composer-meta">
            <ChatPill direction="up" />
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * A divider before a user message whose answer came from another harness or model than
 * the answer before it.
 */
function Switch({ messages, index }: { messages: Message[]; index: number }) {
  const harnesses = useHarnesses();
  const models = useStore((s) => s.models);
  const message = messages[index]!;
  if (message.role !== "user") return null;
  const answer = messages.slice(index + 1).find((m) => m.role === "assistant");
  const before = messages.slice(0, index).findLast((m) => m.role === "assistant");
  if (!answer?.harness || !before?.harness) return null;
  if (answer.harness === before.harness && (answer.model ?? null) === (before.model ?? null)) return null;
  const label = harnesses.find((h) => h.id === answer.harness)?.label ?? answer.harness;
  const model = modelName(models, answer.harness, answer.model);
  return (
    <div className="switch" role="separator">
      <span>Switched to {model && answer.harness === before.harness ? model : model ? `${label} · ${model}` : label}</span>
    </div>
  );
}
