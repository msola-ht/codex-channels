interface WorkerD1Statement {
  bind(...parameters: unknown[]): unknown;
}

interface WorkerD1Database {
  prepare(sql: string): WorkerD1Statement;
  batch(statements: unknown[]): Promise<ReadonlyArray<{ meta?: { changes?: number } }>>;
}

declare const worker: {
  fetch(
    request: Request,
    env: { DB: WorkerD1Database; INGEST_TOKEN?: string },
  ): Promise<Response>;
};

export default worker;
