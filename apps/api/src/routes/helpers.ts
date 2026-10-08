import type { FastifyRequest } from 'fastify';
import { USER_ROLES } from '@bid/shared';

/** Die Rolle kommt aus dem Umschalter der Oberfläche; ohne Login dient sie nur dem Protokoll, nicht dem Zugriffsschutz. */
export function roleOf(req: FastifyRequest): string | undefined {
  const header = req.headers['x-role'];
  const value = Array.isArray(header) ? header[0] : header;
  return USER_ROLES.find((r) => r === value);
}
