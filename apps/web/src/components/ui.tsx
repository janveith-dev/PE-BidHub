import type { ReactNode } from 'react';
import { CATEGORY_LABELS, type DocumentCategory } from '@bid/shared';
import { ApiError } from '../api';

export const VALIDITY_LABEL = {
  valid: 'gültig',
  expiring: 'läuft bald ab',
  expired: 'abgelaufen',
  unlimited: 'unbefristet',
} as const;

export function ValidityBadge({
  validity,
  until,
}: {
  validity: keyof typeof VALIDITY_LABEL;
  until?: string | null;
}) {
  return (
    <span
      className={`badge ${validity === 'unlimited' ? '' : validity}`}
      title={until ? `gültig bis ${until}` : undefined}
    >
      {VALIDITY_LABEL[validity]}
      {until && validity !== 'valid' && validity !== 'unlimited' ? ` · ${formatDate(until)}` : ''}
    </span>
  );
}

export const categoryLabel = (c: DocumentCategory): string => CATEGORY_LABELS[c];

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('de-DE');
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const Spinner = () => <span className="spinner" role="status" aria-label="Lädt" />;

export function Notice({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'warn' | 'error' | 'ok';
  children: ReactNode;
}) {
  return (
    <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Notice kind="error">
      {error instanceof ApiError || error instanceof Error ? error.message : String(error)}
    </Notice>
  );
}

export function Loading({ what = 'Lädt' }: { what?: string }) {
  return (
    <p className="empty">
      <Spinner /> {what} …
    </p>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export function PageHead({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && (
          <p className="muted" style={{ margin: 0 }}>
            {sub}
          </p>
        )}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

/** Lädt eine Datei der API herunter und gibt Serverheader zurück (z. B. Anzahl offener Punkte beim Export). */
export async function downloadFile(
  url: string,
  fallbackName: string,
  role: string,
): Promise<Headers> {
  const res = await fetch(url, { headers: { 'x-role': role } });
  if (!res.ok) {
    let message = `Download fehlgeschlagen (HTTP ${res.status})`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* keine JSON-Antwort */
    }
    throw new ApiError(res.status, message);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : fallbackName;
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return res.headers;
}
