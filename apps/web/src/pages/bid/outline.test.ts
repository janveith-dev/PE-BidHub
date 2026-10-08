import type { OutlineSection } from '@bid/shared';
import { describe, expect, it } from 'vitest';
import { renumber, unassignedMust } from './OutlineEditor';

const sec = (level: number, ids: string[] = []): OutlineSection => ({ id: `s${Math.random()}`, number: '', title: 't', level, purpose: '', requirementIds: ids, authorRole: 'security' });

describe('Gliederung', () => {
  it('vergibt hierarchische Nummern aus den Ebenen', () => {
    expect(renumber([sec(1), sec(2), sec(2), sec(1), sec(2), sec(3), sec(3), sec(2), sec(1)]).map((s) => s.number)).toEqual(['1', '1.1', '1.2', '2', '2.1', '2.1.1', '2.1.2', '2.2', '3']);
  });
  it('beginnt bei fehlender übergeordneter Ebene mit 1', () => {
    expect(renumber([sec(2), sec(2)]).map((s) => s.number)).toEqual(['1.1', '1.2']);
    expect(renumber([sec(3)]).map((s) => s.number)).toEqual(['1.1.1']);
  });
  it('findet Muss-Anforderungen ohne Kapitel', () => {
    const a = {
      summary: '', language: 'de' as const, formalRules: [], evaluationCriteria: [], customerTerms: [],
      requirements: [
        { id: 'R-001', text: 'a', kind: 'must' as const, topic: '' },
        { id: 'R-002', text: 'b', kind: 'must' as const, topic: '' },
        { id: 'R-003', text: 'c', kind: 'should' as const, topic: '' },
      ],
      outline: [sec(1, ['R-001'])],
    };
    expect(unassignedMust(a).map((r) => r.id)).toEqual(['R-002']);
  });
});
