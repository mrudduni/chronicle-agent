/**
 * The memory map: what the agent remembers, drawn on a timeline.
 *
 *     things      (Supabase)   (Neon)   (HubSpot)  ...      <- what was discussed
 *                    |  \        |         |
 *     conversations [Tue 3 Nov]          [Mon 9 Nov]        <- when, by local day
 *
 * A line means "in this conversation I stated facts about this thing"; it's
 * thicker the more facts there were. Hover a thing to see its conversations,
 * click it for everything said about it, click a conversation to open it.
 *
 * The layout is computed here, deterministically, rather than with a force
 * simulation: time runs left to right, which is the one axis that matters
 * for "what did we say, and when", and the picture doesn't jump around
 * between visits.
 */
import { useMemo, useState } from "react";
import type { MemoryMap } from "./api";

const COL_W = 210; // one column per day with conversations
const PAD_X = 40;
const LANE_Y = [56, 116, 176]; // rows for thing nodes
const AXIS_Y = 236;
const CARD_Y = 270;
const CARD_W = 184;
const CARD_H = 56;
const CARD_GAP = 12;
const MIN_GAP = 18; // between thing nodes in one row

interface Props {
  map: MemoryMap;
  selected: string | null;
  onSelect: (key: string) => void;
  onOpenConversation: (threadId: string) => void;
}

export function MemoryMapView({ map, selected, onSelect, onOpenConversation }: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const layout = useMemo(() => layOut(map), [map]);
  const focus = hover ?? selected;
  const linkedTurns = new Set(focus ? map.links.filter((l) => l.thing === focus).map((l) => l.turnId) : []);

  if (map.conversations.length === 0) {
    return (
      <div className="map-empty">
        <h2>Nothing remembered yet</h2>
        <p>After each answer, the facts it stated (prices, plans, launches) are filed here by what they're about and when they were said.</p>
      </div>
    );
  }

  return (
    <div className="map-scroll">
      <svg className="map" width={layout.width} height={layout.height} role="img" aria-label="Memory map: things discussed, linked to the conversations they came up in">
        {/* day axis */}
        <line x1={PAD_X / 2} x2={layout.width - PAD_X / 2} y1={AXIS_Y} y2={AXIS_Y} className="axis" />
        {layout.days.map((d) => (
          <g key={d.day}>
            <line x1={d.x} x2={d.x} y1={AXIS_Y - 5} y2={AXIS_Y + 5} className="axis" />
            <text x={d.x} y={AXIS_Y + 22} className="day-label" textAnchor="middle">
              {d.label}
            </text>
          </g>
        ))}

        {/* links */}
        {map.links.map((l) => {
          const t = layout.things.get(l.thing);
          const c = layout.cards.get(l.turnId);
          if (!t || !c) return null;
          const on = focus === l.thing;
          const y1 = t.y + 13;
          const y2 = c.y - 2;
          return (
            <path
              key={`${l.thing}-${l.turnId}`}
              d={`M ${t.x} ${y1} C ${t.x} ${(y1 + y2) / 2}, ${c.x} ${(y1 + y2) / 2}, ${c.x} ${y2}`}
              className={`link ${on ? "on" : focus ? "dim" : ""}`}
              strokeWidth={Math.min(1 + l.facts * 0.6, 4)}
            />
          );
        })}

        {/* conversations */}
        {map.conversations.map((conv) => {
          const c = layout.cards.get(conv.turnId)!;
          const on = linkedTurns.has(conv.turnId);
          return (
            <foreignObject key={conv.turnId} x={c.x - CARD_W / 2} y={c.y} width={CARD_W} height={CARD_H}>
              <button
                className={`map-card ${on ? "on" : focus ? "dim" : ""}`}
                onClick={() => onOpenConversation(conv.threadId)}
                title={`${conv.question}\n\nClick to open this conversation`}
              >
                <span className="time">{new Date(conv.askedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
                <span className="q">{conv.question}</span>
              </button>
            </foreignObject>
          );
        })}

        {/* things */}
        {map.things.map((thing) => {
          const t = layout.things.get(thing.key);
          if (!t) return null;
          const on = focus === thing.key;
          return (
            <g
              key={thing.key}
              className={`thing ${thing.type} ${on ? "on" : focus ? "dim" : ""} ${selected === thing.key ? "selected" : ""}`}
              transform={`translate(${t.x - t.w / 2}, ${t.y - 13})`}
              onMouseEnter={() => setHover(thing.key)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect(thing.key)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(thing.key)}
              tabIndex={0}
              role="button"
              aria-label={`${thing.name}: ${thing.facts} ${thing.facts === 1 ? "fact" : "facts"}`}
            >
              <rect width={t.w} height={26} rx={13} />
              <text x={t.w / 2} y={17} textAnchor="middle">
                {thing.name}
                <tspan className="count" dx={5}>
                  {thing.facts}
                </tspan>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface Layout {
  width: number;
  height: number;
  days: Array<{ day: string; x: number; label: string }>;
  cards: Map<number, { x: number; y: number }>;
  things: Map<string, { x: number; y: number; w: number }>;
}

function layOut(map: MemoryMap): Layout {
  // Days: one column each, oldest on the left.
  const dayList = [...new Set(map.conversations.map((c) => c.day))].sort();
  const dayX = new Map(dayList.map((d, i) => [d, PAD_X + COL_W / 2 + i * COL_W]));
  const width = Math.max(PAD_X * 2 + dayList.length * COL_W, 640);

  // Conversations: stacked under their day.
  const cards = new Map<number, { x: number; y: number }>();
  const perDay = new Map<string, number>();
  for (const c of map.conversations) {
    const i = perDay.get(c.day) ?? 0;
    perDay.set(c.day, i + 1);
    cards.set(c.turnId, { x: dayX.get(c.day)!, y: CARD_Y + i * (CARD_H + CARD_GAP) });
  }
  const tallest = Math.max(...perDay.values());

  // Things: above the conversations they came up in (the mean x), spread
  // over a few rows so labels don't overlap.
  const wanted = map.things
    .map((t) => {
      const xs = map.links.filter((l) => l.thing === t.key).map((l) => cards.get(l.turnId)?.x).filter((x): x is number => x != null);
      return { key: t.key, x: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : PAD_X, w: Math.max(56, t.name.length * 7.4 + 34) };
    })
    .sort((a, b) => a.x - b.x);
  const rowEnds = LANE_Y.map(() => -Infinity);
  const things = new Map<string, { x: number; y: number; w: number }>();
  for (const t of wanted) {
    // The row where it fits closest to where it wants to be.
    let best = 0;
    let bestX = Infinity;
    rowEnds.forEach((end, row) => {
      const x = Math.max(t.x, end + MIN_GAP + t.w / 2);
      if (Math.abs(x - t.x) < Math.abs(bestX - t.x)) {
        best = row;
        bestX = x;
      }
    });
    rowEnds[best] = bestX + t.w / 2;
    things.set(t.key, { x: bestX, y: LANE_Y[best]!, w: t.w });
  }
  const right = Math.max(...[...things.values()].map((t) => t.x + t.w / 2), 0);

  const today = new Date().toLocaleDateString("en-CA");
  const days = dayList.map((day) => ({ day, x: dayX.get(day)!, label: dayLabel(day, today) }));
  return { width: Math.max(width, right + PAD_X), height: CARD_Y + tallest * (CARD_H + CARD_GAP) + 10, days, cards, things };
}

function dayLabel(day: string, today: string) {
  const d = new Date(`${day}T12:00:00`);
  const ago = Math.round((Date.parse(`${today}T12:00:00`) - d.getTime()) / 86_400_000);
  const when = ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · ${when}`;
}
