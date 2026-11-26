import type { ActivityKind } from "@staf/protocol";

const paths = {
  plus: "M12 5v14M5 12h14",
  send: "M12 19V5M6 11l6-6 6 6",
  stop: "M8 8h8v8H8z",
  chevron: "M9 6l6 6-6 6",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6L6 18",
  trash: "M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4-4",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9S9.5 5.7 12 3z",
  terminal: "M5 7l5 5-5 5M12 17h7",
  tool: "M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-3-3z",
  file: "M7 3h7l5 5v13H7zM14 3v5h5",
  note: "M5 6h14M5 12h14M5 18h9",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  alert: "M12 9v4M12 17h.01M10.3 4.3L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  down: "M7 10l5 5 5-5",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2 1.2L14.8 21h-4l-.3-2.4a7 7 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-2.4L4.6 9.9l2-3.4 1.9.7a7 7 0 0 1 2-1.2L10.8 3h4l.3 2.4a7 7 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 2.4z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0",
  edit: "M16.5 4.5l3 3L8 19l-4 1 1-4L16.5 4.5z",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
  appearance: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 3v18M12 8h5M12 12h7M12 16h5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  inbox: "M4 13h4l2 3h4l2-3h4M5.5 6h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z",
  paperclip:
    "M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9.2-9.2a3.3 3.3 0 0 1 4.6 4.6l-9.2 9.2a1.6 1.6 0 0 1-2.3-2.3L16 7",
  download: "M12 4v12M7 11l5 5 5-5M5 20h14",
  external: "M14 5h5v5M10 14L19 5M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export const activityIcon: Record<ActivityKind, IconName> = {
  search: "search",
  page: "globe",
  command: "terminal",
  tool: "tool",
  file: "file",
  note: "note",
  reasoning: "spark",
  other: "spark",
};
