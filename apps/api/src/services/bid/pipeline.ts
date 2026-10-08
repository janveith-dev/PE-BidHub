import { SpecAnalysisSchema, type BidDocumentStatus, type SpecAnalysis } from '@bid/shared';
import type { AppContext } from '../../context.js';
import { HttpError } from '../errors.js';
import { runAnalyst } from './analyst.js';
import { researchSection } from './research.js';
import { reviewDocument } from './reviewer.js';
import { mapPool, type Emit } from './run.js';
import {
  getBid, getBidDocument, getSection, listSections, logEvent, optionsOf, replaceSections, saveSectionContent,
  saveSectionFacts, setSectionStatus, setStatus, transition, type BidDocumentRow, type SectionRow,
} from './store.js';
import { polishText, reviseText, writeSection } from './writer.js';

const EDITABLE: BidDocumentStatus[] = ['written', 'reviewed'];

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Ergebnis der Strukturprüfung einer vom Bid Manager bearbeiteten Analyse. */
export interface OutlineIssues {
  errors: string[];
  unassignedMust: string[];
}

export function validateAnalysis(a: SpecAnalysis): OutlineIssues {
  const errors: string[] = [];
  const requirementIds = new Set(a.requirements.map((r) => r.id));
  if (requirementIds.size !== a.requirements.length) errors.push('Anforderungs-IDs sind nicht eindeutig.');
  const sectionIds = new Set(a.outline.map((s) => s.id));
  if (sectionIds.size !== a.outline.length) errors.push('Kapitel-IDs sind nicht eindeutig.');
  for (const s of a.outline) {
    const unknown = s.requirementIds.filter((id) => !requirementIds.has(id));
    if (unknown.length) errors.push(`Kapitel ${s.number} verweist auf unbekannte Anforderungen: ${unknown.join(', ')}.`);
  }
  const assigned = new Set(a.outline.flatMap((s) => s.requirementIds));
  const unassignedMust = a.requirements.filter((r) => r.kind === 'must' && !assigned.has(r.id)).map((r) => r.id);
  return { errors, unassignedMust };
}

/**
 * Führt das Bid-Studio: Analyse → Freigabe der Gliederung → Recherche und Schreiben je Kapitel → Prüfung.
 * Läufe laufen im Hintergrund des Servers; der Stand steht in der Datenbank und im Ereignisprotokoll,
 * sodass die Oberfläche ihn abfragt. Je Dokument läuft höchstens ein Vorgang.
 */
export class BidPipeline {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: { concurrency?: number; today?: () => string } = {},
  ) {}

  private get db() {
    return this.ctx.db;
  }
  private emit(docId: string): Emit {
    return (e) => logEvent(this.db, docId, e);
  }
  private get today(): string {
    return this.opts.today?.() ?? new Date().toISOString().slice(0, 10);
  }

  isRunning(docId: string): boolean {
    return this.running.has(docId);
  }

  /** Wartet auf laufende Vorgänge (Tests, geordnetes Herunterfahren). */
  async idle(docId?: string): Promise<void> {
    await Promise.all(docId ? [this.running.get(docId)] : [...this.running.values()]);
  }

  private assertFree(docId: string): void {
    if (this.running.has(docId)) throw new HttpError(409, 'Für dieses Dokument läuft bereits ein Vorgang. Bitte warten, bis er beendet ist.');
  }

  private launch(docId: string, job: () => Promise<void>, onFail: (error: unknown) => Promise<void>): void {
    const promise = (async () => {
      try {
        await job();
      } catch (error) {
        try {
          await onFail(error);
        } catch {
          // Wenn auch das Aufräumen scheitert, bleibt nur der Wiederanlauf beim nächsten Start.
        }
      } finally {
        this.running.delete(docId);
      }
    })();
    this.running.set(docId, promise);
  }

  // --- 1. Analyse --------------------------------------------------------------------------

  async startAnalysis(docId: string): Promise<BidDocumentRow> {
    this.assertFree(docId);
    const doc = await transition(this.db, docId, ['draft', 'failed', 'outline_review'], 'analyzing');
    const emit = this.emit(docId);
    await emit({ agent: 'system', kind: 'info', message: 'Analyse der Kundenvorgabe gestartet' });

    this.launch(
      docId,
      async () => {
        const bid = await getBid(this.db, doc.bid_id);
        const { analysis, warnings } = await runAnalyst(this.ctx, doc, bid, emit);
        await replaceSections(this.db, docId, analysis.outline);
        await this.db.query(
          `UPDATE bid_documents SET analysis = $2::jsonb, outline_approved_at = NULL, coverage = NULL, findings = NULL,
                  review_summary = NULL, status = 'outline_review', error = NULL, updated_at = now() WHERE id = $1`,
          [docId, JSON.stringify(analysis)],
        );
        for (const w of warnings) await emit({ agent: 'analyst', kind: 'gate', message: w });
        await emit({ agent: 'system', kind: 'gate', message: 'Gliederung liegt zur Freigabe vor. Es wird erst geschrieben, wenn sie freigegeben ist.' });
      },
      async (error) => {
        await setStatus(this.db, docId, 'failed', messageOf(error));
        await emit({ agent: 'analyst', kind: 'error', message: `Analyse fehlgeschlagen: ${messageOf(error)}` });
      },
    );
    return doc;
  }

  // --- 2. Bearbeitung und Freigabe der Gliederung -----------------------------------------------

  async saveAnalysis(docId: string, input: unknown): Promise<{ analysis: SpecAnalysis; issues: OutlineIssues }> {
    this.assertFree(docId);
    const doc = await getBidDocument(this.db, docId);
    if (doc.status !== 'outline_review') {
      throw new HttpError(409, 'Die Gliederung lässt sich nur bearbeiten, solange sie zur Freigabe vorliegt.');
    }
    const analysis = SpecAnalysisSchema.parse(input);
    const issues = validateAnalysis(analysis);
    if (issues.errors.length) throw new HttpError(422, issues.errors.join(' '));

    await replaceSections(this.db, docId, analysis.outline);
    await this.db.query('UPDATE bid_documents SET analysis = $2::jsonb, updated_at = now() WHERE id = $1', [docId, JSON.stringify(analysis)]);
    await this.emit(docId)({ agent: 'system', kind: 'info', message: 'Gliederung vom Bid Manager angepasst' });
    return { analysis, issues };
  }

  async approveOutline(docId: string, opts: { force?: boolean } = {}): Promise<BidDocumentRow> {
    this.assertFree(docId);
    const doc = await getBidDocument(this.db, docId);
    if (doc.status !== 'outline_review' || !doc.analysis) {
      throw new HttpError(409, 'Es liegt keine Gliederung zur Freigabe vor.');
    }
    const issues = validateAnalysis(doc.analysis);
    if (!doc.analysis.outline.length) throw new HttpError(422, 'Die Gliederung ist leer.');
    if (issues.unassignedMust.length && !opts.force) {
      throw new HttpError(
        409,
        `Diese Muss-Anforderungen sind keinem Kapitel zugeordnet: ${issues.unassignedMust.join(', ')}. Bitte zuordnen oder die Freigabe ausdrücklich bestätigen.`,
      );
    }

    const approved = await transition(this.db, docId, ['outline_review'], 'writing');
    await this.db.query('UPDATE bid_documents SET outline_approved_at = now() WHERE id = $1', [docId]);
    const emit = this.emit(docId);
    await emit({
      agent: 'system', kind: 'gate',
      message: `Gliederung freigegeben${issues.unassignedMust.length ? ` (mit ${issues.unassignedMust.length} nicht zugeordneten Muss-Anforderungen)` : ''}. Die Autoren beginnen.`,
    });
    this.launch(docId, () => this.writeAll(approved, ['pending', 'failed']), (e) => this.failWriting(docId, e));
    return approved;
  }

  // --- 3. Schreiben ----------------------------------------------------------------------------

  private async failWriting(docId: string, error: unknown): Promise<void> {
    await setStatus(this.db, docId, 'written', messageOf(error));
    await this.emit(docId)({ agent: 'system', kind: 'error', message: `Schreiblauf abgebrochen: ${messageOf(error)}` });
  }

  /** Recherchiert und schreibt alle Kapitel in den angegebenen Zuständen; ein gescheitertes Kapitel stoppt die anderen nicht. */
  private async writeAll(doc: BidDocumentRow, statuses: string[]): Promise<void> {
    const sections = (await listSections(this.db, doc.id)).filter((s) => statuses.includes(s.status));
    await mapPool(sections, this.opts.concurrency ?? 3, (s) => this.produceSection(doc.id, s.id, {}));

    const after = await listSections(this.db, doc.id);
    const failed = after.filter((s) => s.status === 'failed');
    await setStatus(this.db, doc.id, 'written', failed.length ? `${failed.length} Kapitel konnten nicht geschrieben werden.` : null);
    await this.emit(doc.id)({
      agent: 'system', kind: failed.length ? 'error' : 'gate',
      message: failed.length
        ? `Entwurf fertig, aber ${failed.length} Kapitel sind fehlgeschlagen. Sie lassen sich einzeln neu schreiben.`
        : 'Entwurf fertig. Als Nächstes kann die Prüfung laufen.',
    });
  }

  /** Recherche und Text für ein Kapitel. Fehler werden am Kapitel vermerkt, nicht weitergeworfen. */
  private async produceSection(docId: string, sectionId: string, o: { instruction?: string; keepText?: boolean }): Promise<void> {
    const emit = this.emit(docId);
    try {
      const doc = await getBidDocument(this.db, docId);
      const bid = await getBid(this.db, doc.bid_id);
      const analysis = doc.analysis!;
      let section = await getSection(this.db, sectionId);
      const requirements = analysis.requirements.filter((r) => section.requirement_ids.includes(r.id));

      await setSectionStatus(this.db, sectionId, 'researching');
      await emit({ agent: 'system', sectionId, kind: 'info', message: `Kapitel ${section.number} „${section.title}": Recherche` });
      const research = await researchSection(this.ctx, {
        bid, doc, analysis, section, requirements, allowWeb: optionsOf(doc).allowWeb, instruction: o.instruction, emit,
      });
      await saveSectionFacts(this.db, sectionId, research.facts);

      await setSectionStatus(this.db, sectionId, 'writing');
      section = await getSection(this.db, sectionId);
      const written = await writeSection(this.ctx, {
        bid, doc, analysis, section, requirements, facts: research.facts, gaps: research.gaps, gapsReported: research.gapsReported,
        instruction: o.instruction, previous: o.keepText ? section.content : undefined, emit,
      });
      await saveSectionContent(this.db, sectionId, written.content, `agent:writer:${section.author_role}`, {
        status: 'written', notes: written.notes,
      });
    } catch (error) {
      await setSectionStatus(this.db, sectionId, 'failed', messageOf(error)).catch(() => undefined);
      await emit({ agent: 'system', sectionId, kind: 'error', message: `Kapitel fehlgeschlagen: ${messageOf(error)}` });
    }
  }

  /** Fehlgeschlagene oder offene Kapitel erneut versuchen. */
  async retryFailed(docId: string): Promise<BidDocumentRow> {
    this.assertFree(docId);
    const doc = await transition(this.db, docId, EDITABLE, 'writing');
    this.launch(docId, () => this.writeAll(doc, ['pending', 'failed']), (e) => this.failWriting(docId, e));
    return doc;
  }

  /** Ein Kapitel komplett neu recherchieren und schreiben, optional mit Anweisung des Bid Managers. */
  async rewriteSection(docId: string, sectionId: string, instruction?: string): Promise<BidDocumentRow> {
    this.assertFree(docId);
    await this.assertSectionOf(docId, sectionId);
    const doc = await transition(this.db, docId, EDITABLE, 'writing');
    await this.emit(docId)({ agent: 'system', sectionId, kind: 'info', message: instruction ? `Kapitel wird neu geschrieben: ${instruction}` : 'Kapitel wird neu geschrieben' });
    this.launch(
      docId,
      async () => {
        await this.produceSection(docId, sectionId, { ...(instruction ? { instruction } : {}), keepText: true });
        await setStatus(this.db, docId, 'written');
      },
      (e) => this.failWriting(docId, e),
    );
    return doc;
  }

  /** Bestehenden Text nach Anweisung überarbeiten, ohne neu zu recherchieren (Befund beheben, kürzen, umformulieren). */
  async reviseSection(docId: string, sectionId: string, instruction: string): Promise<BidDocumentRow> {
    this.assertFree(docId);
    await this.assertSectionOf(docId, sectionId);
    const doc = await transition(this.db, docId, EDITABLE, 'writing');
    const emit = this.emit(docId);
    await emit({ agent: 'system', sectionId, kind: 'info', message: `Überarbeitung: ${instruction}` });

    this.launch(
      docId,
      async () => {
        const section = await getSection(this.db, sectionId);
        const bid = await getBid(this.db, doc.bid_id);
        const revised = await reviseText(this.ctx, {
          bid, doc, analysis: doc.analysis!, section, facts: section.facts, content: section.content, instruction, emit,
        });
        await saveSectionContent(this.db, sectionId, revised.content, 'agent:lektor', { status: 'written' });
        await setStatus(this.db, docId, 'written');
      },
      (e) => this.failWriting(docId, e),
    );
    return doc;
  }

  /** Manuelle Änderung durch den Bid Manager. Macht eine bestehende Prüfung ungültig. */
  async editSection(docId: string, sectionId: string, content: string, role: string | undefined): Promise<SectionRow> {
    this.assertFree(docId);
    await this.assertSectionOf(docId, sectionId);
    const doc = await getBidDocument(this.db, docId);
    if (!EDITABLE.includes(doc.status)) throw new HttpError(409, 'Kapitel lassen sich erst bearbeiten, wenn der Entwurf fertig ist.');
    const section = await saveSectionContent(this.db, sectionId, content, `user:${role ?? 'unbekannt'}`, { status: 'written' });
    if (doc.status === 'reviewed') await setStatus(this.db, docId, 'written');
    return section;
  }

  /** Stilpass über alle Kapitel; verändert ein Ergebnis Zahlen oder Quellenmarken, wird es verworfen. */
  async polish(docId: string): Promise<BidDocumentRow> {
    this.assertFree(docId);
    const doc = await transition(this.db, docId, EDITABLE, 'writing');
    const emit = this.emit(docId);
    await emit({ agent: 'system', kind: 'info', message: 'Lektorat über alle Kapitel gestartet' });

    this.launch(
      docId,
      async () => {
        const bid = await getBid(this.db, doc.bid_id);
        const sections = (await listSections(this.db, docId)).filter((s) => s.status === 'written' && s.content.trim());
        await mapPool(sections, this.opts.concurrency ?? 3, async (section) => {
          try {
            const result = await polishText(this.ctx, { bid, doc, analysis: doc.analysis!, section, facts: section.facts, content: section.content, emit });
            if (result.changed) await saveSectionContent(this.db, section.id, result.content, 'agent:lektor', { status: 'written' });
            else if (result.reason) await emit({ agent: 'lektor', sectionId: section.id, kind: 'info', message: result.reason });
          } catch (error) {
            await emit({ agent: 'lektor', sectionId: section.id, kind: 'error', message: `Lektorat fehlgeschlagen: ${messageOf(error)}` });
          }
        });
        await setStatus(this.db, docId, 'written');
        await emit({ agent: 'system', kind: 'info', message: 'Lektorat abgeschlossen. Die Prüfung sollte erneut laufen.' });
      },
      (e) => this.failWriting(docId, e),
    );
    return doc;
  }

  // --- 4. Prüfung ------------------------------------------------------------------------------

  async startReview(docId: string, opts: { force?: boolean } = {}): Promise<BidDocumentRow> {
    this.assertFree(docId);
    const sections = await listSections(this.db, docId);
    const notWritten = sections.filter((s) => s.status !== 'written');
    if (notWritten.length && !opts.force) {
      throw new HttpError(409, `Diese Kapitel sind noch nicht fertig: ${notWritten.map((s) => s.number).join(', ')}. Erst fertigstellen oder die Prüfung ausdrücklich bestätigen.`);
    }
    const doc = await transition(this.db, docId, EDITABLE, 'reviewing');
    const emit = this.emit(docId);
    await emit({ agent: 'system', kind: 'info', message: 'Unabhängige Prüfung gestartet' });

    this.launch(
      docId,
      async () => {
        const bid = await getBid(this.db, doc.bid_id);
        const fresh = await listSections(this.db, docId);
        const review = await reviewDocument(this.ctx, { bid, doc, analysis: doc.analysis!, sections: fresh, emit, today: this.today });
        await this.db.query(
          `UPDATE bid_documents SET coverage = $2::jsonb, findings = $3::jsonb, review_summary = $4, status = 'reviewed', error = NULL, updated_at = now() WHERE id = $1`,
          [docId, JSON.stringify(review.coverage), JSON.stringify(review.findings), review.summary],
        );
        await emit({ agent: 'system', kind: 'gate', message: 'Prüfung abgeschlossen. Befunde lassen sich gezielt nacharbeiten.' });
      },
      async (error) => {
        await setStatus(this.db, docId, 'written', messageOf(error));
        await emit({ agent: 'reviewer', kind: 'error', message: `Prüfung fehlgeschlagen: ${messageOf(error)}` });
      },
    );
    return doc;
  }

  private async assertSectionOf(docId: string, sectionId: string): Promise<void> {
    const s = await getSection(this.db, sectionId);
    if (s.bid_document_id !== docId) throw new HttpError(404, 'Kapitel gehört nicht zu diesem Dokument');
  }
}
