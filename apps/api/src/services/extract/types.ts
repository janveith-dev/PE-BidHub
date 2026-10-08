/** Ein zusammenhängender Textabschnitt eines Dokuments (Seite, Folie, Tabellenblatt …). */
export interface Section {
  heading: string | null;
  page: number | null;
  text: string;
  /** Kopfzeile einer Tabelle: wird jedem Chunk des Abschnitts vorangestellt. */
  repeatLine?: string;
}

export interface Extracted {
  sections: Section[];
  /** native = Text aus der Datei, text = Klartext, ocr = Texterkennung auf Bildern. */
  method: 'native' | 'text' | 'ocr';
  warnings: string[];
}

export interface OcrProvider {
  /** Erkennt Text in einer Bild- oder PDF-Datei; liefert Text je Seite. */
  ocr(buffer: Buffer, mime: string, filename: string): Promise<string[]>;
}

export interface ExtractContext {
  ocr?: OcrProvider | undefined;
}
