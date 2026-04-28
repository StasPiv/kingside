export class ApiError extends Error {
  public readonly errorCode: string | undefined;
  /** KS-2099: HTTP-статус ответа (нужен, чтобы отличать 404 от 500 на UI). */
  public readonly status: number | undefined;

  constructor(message: string, errorCode?: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.errorCode = errorCode;
    this.status = status;
  }
}
