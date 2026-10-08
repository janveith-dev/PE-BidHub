export type Validity = 'valid' | 'expiring' | 'expired' | 'unlimited';

const EXPIRING_DAYS = 60;

/**
 * Gültigkeit eines Dokuments zum Stichtag. Das Datum wird als Kalendertag
 * verglichen, nicht als Zeitpunkt: „gültig bis 31.12." gilt den ganzen Tag.
 */
export function validityOf(validUntil: string | null | undefined, today = new Date()): Validity {
  if (!validUntil) return 'unlimited';
  const end = Date.parse(`${validUntil}T23:59:59.999Z`);
  const now = today.getTime();
  if (Number.isNaN(end)) return 'unlimited';
  if (end < now) return 'expired';
  if (end - now <= EXPIRING_DAYS * 86_400_000) return 'expiring';
  return 'valid';
}
