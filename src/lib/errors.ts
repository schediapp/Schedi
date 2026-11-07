export class SchediError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SchediError";
    this.status = status;
  }
}
