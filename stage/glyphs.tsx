// bb-plugin-bot-stage — the few icons the stage draws itself.
//
// Inline, so the stage never depends on which icon names a given BB build
// happens to ship, and so the preview harness renders them without a host.
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement>;

function Svg(props: Props) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export const Terminal = (p: Props) => (
  <Svg {...p}>
    <path d="M3 4.5l3.5 3.5L3 11.5M8.5 12H13" />
  </Svg>
);
export const FileText = (p: Props) => (
  <Svg {...p}>
    <path d="M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 10.5h4" />
  </Svg>
);
export const Pencil = (p: Props) => (
  <Svg {...p}>
    <path d="M10.5 3.5l2 2L6 12l-3 1 1-3z" />
  </Svg>
);
export const Search = (p: Props) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4" />
    <path d="M10 10l3.5 3.5" />
  </Svg>
);
export const Globe = (p: Props) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" />
  </Svg>
);
export const Wrench = (p: Props) => (
  <Svg {...p}>
    <path d="M10.5 2.5a3 3 0 00-2.6 4.2L3 11.6 4.4 13l4.9-4.9a3 3 0 004.2-2.6l-1.8 1.8-1.7-.4-.4-1.7z" />
  </Svg>
);
export const Brain = (p: Props) => (
  <Svg {...p}>
    <path d="M6 3a2 2 0 00-2 2 2 2 0 00-1 3.5A2.2 2.2 0 005 12a2 2 0 003 1V3.5A1.5 1.5 0 006 3zM10 3a2 2 0 012 2 2 2 0 011 3.5A2.2 2.2 0 0111 12a2 2 0 01-3 1" />
  </Svg>
);
export const Close = (p: Props) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const PopOut = (p: Props) => (
  <Svg {...p}>
    <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />
  </Svg>
);
export const Check = (p: Props) => (
  <Svg {...p}>
    <path d="M3 8.5l3 3 7-7" />
  </Svg>
);
export const Layers = (p: Props) => (
  <Svg {...p}>
    <path d="M8 2.5l5.5 3L8 8.5l-5.5-3zM2.5 8L8 11l5.5-3M2.5 10.5L8 13.5l5.5-3" />
  </Svg>
);

const BY_KIND: Record<string, (p: Props) => React.JSX.Element> = {
  commandExecution: Terminal,
  backgroundTask: Terminal,
  fileRead: FileText,
  fileChange: Pencil,
  search: Search,
  webFetch: Globe,
  webSearch: Globe,
  reasoning: Brain,
};

/** The glyph for a kind of work; a wrench when it is something else. */
export function KindGlyph({ kind, ...props }: { kind: string | null } & Props) {
  const Glyph = (kind !== null && BY_KIND[kind]) || Wrench;
  return <Glyph {...props} />;
}
