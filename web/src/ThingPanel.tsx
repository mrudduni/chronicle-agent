/**
 * Everything the agent has said about one thing, oldest first, grouped by
 * what it was about ("price · Pro plan"). Where a later conversation recorded
 * a different value, both are shown, so a change over time is visible at a
 * glance. Each fact links to its source and to the conversation it came from.
 */
import { useEffect, useState } from "react";
import { type ThingDetail, api } from "./api";
import { hostOf } from "./Message";

interface Props {
  thingKey: string | null;
  onClose: () => void;
  onOpenConversation: (threadId: string) => void;
  onAsk: (text: string) => void;
}

export function ThingPanel({ thingKey, onClose, onOpenConversation, onAsk }: Props) {
  const [detail, setDetail] = useState<ThingDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setDetail(null);
    setFailed(false);
    if (!thingKey) return;
    let live = true;
    api
      .thing(thingKey)
      .then((d) => live && setDetail(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [thingKey]);

  const groups = detail ? groupFacts(detail.facts) : [];
  const first = detail?.facts[0]?.day;

  return (
    <aside className="research" aria-label="What I know">
      <div className="research-head">
        <div>
          <div className="research-title">{detail?.name ?? "Memory map"}</div>
          <div className="research-q">
            {detail ? `${detail.facts.length} ${detail.facts.length === 1 ? "fact" : "facts"}${first ? `, first mentioned ${first}` : ""}` : "Click a thing on the map to see everything said about it."}
          </div>
        </div>
        <button className="icon" onClick={onClose} title="Close panel" aria-label="Close panel">
          ×
        </button>
      </div>

      <div className="research-body">
        {!thingKey && (
          <p className="research-empty">
            Things above the timeline are what we talked about; cards below are the conversations, by day. Lines show where facts about each thing
            came from.
          </p>
        )}
        {failed && <p className="research-empty">Couldn't load this one.</p>}

        {detail && (
          <>
            <button className="ask-recheck" onClick={() => onAsk(`Has anything changed for ${detail.name} since we last talked about it?`)}>
              Ask: has anything changed for {detail.name}?
            </button>

            {groups.map((g) => (
              <section key={g.label}>
                <h3>{g.label}</h3>
                <ol className="fact-timeline">
                  {g.facts.map((f) => (
                    <li key={f.claimId} className={`fact ${f.supersededBy ? "old" : ""} ${f.status === "unsourced" ? "unsourced" : ""}`}>
                      <div className="fact-head">
                        <span className="value">{f.value}</span>
                        <span className="day">{f.day}</span>
                      </div>
                      <div className="quote">“{f.quote.replace(/\s*\[S\d+(?:\s*,\s*S\d+)*\]/g, "")}”</div>
                      <div className="fact-links">
                        {f.sourceUrl ? (
                          <a href={f.sourceUrl} target="_blank" rel="noreferrer">
                            {hostOf(f.sourceUrl)}
                            {f.sourcePublishedAt ? ` · ${f.sourcePublishedAt}` : ""}
                          </a>
                        ) : (
                          <span className="warn">{f.status === "user" ? "said by you" : "no source"}</span>
                        )}
                        <button className="link" onClick={() => onOpenConversation(f.threadId)}>
                          open conversation
                        </button>
                        {f.supersededBy && <span className="tag">later value recorded</span>}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ))}

            {detail.topics.some((t) => t.openItems.length > 0) && (
              <section>
                <h3>Left open</h3>
                {detail.topics.map((t) =>
                  t.openItems.map((item, i) => (
                    <div key={`${t.label}-${i}`} className="r-note">
                      {item} <span className="faint">({t.label})</span>
                    </div>
                  )),
                )}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/** "price · Pro", "price · Launch", "egress"...: one group per attribute and plan. */
function groupFacts(facts: ThingDetail["facts"]) {
  const groups = new Map<string, ThingDetail["facts"]>();
  for (const f of facts) {
    const plan = f.qualifiers.plan;
    const label = plan ? `${f.attribute} · ${plan}` : f.attribute;
    groups.set(label, [...(groups.get(label) ?? []), f]);
  }
  return [...groups].map(([label, facts]) => ({ label, facts }));
}
