/** Fehler mit HTTP-Status; der Fehlerhandler gibt Text und Status an den Client weiter. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string): HttpError => new HttpError(404, `${what} nicht gefunden`);
export const badRequest = (message: string): HttpError => new HttpError(400, message);
export const unprocessable = (message: string): HttpError => new HttpError(422, message);
