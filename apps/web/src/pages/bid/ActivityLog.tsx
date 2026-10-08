import type { AgentEventDto, SectionDto } from '@bid/shared';
import { agentLabel } from './labels';

export function ActivityLog({
  events,
  sections,
  limit,
}: {
  events: AgentEventDto[];
  sections: SectionDto[];
  limit?: number;
}) {
  const shown = limit ? events.slice(-limit) : events;
  const number = (id: string | null) => sections.find((s) => s.id === id)?.number;
  if (!shown.length) return <p className="muted small">Noch keine Aktivität.</p>;
  return (
    <div className="log" role="log" aria-label="Protokoll der Agenten">
      {shown.map((e) => (
        <div key={e.id} className={e.kind}>
          <span className="t">{new Date(e.createdAt).toLocaleTimeString('de-DE')}</span>
          <span className="a" title={agentLabel(e.agent)}>
            {agentLabel(e.agent)}
          </span>
          <span>
            {number(e.sectionId) ? `[Kap. ${number(e.sectionId)}] ` : ''}
            {e.message}
          </span>
        </div>
      ))}
    </div>
  );
}
