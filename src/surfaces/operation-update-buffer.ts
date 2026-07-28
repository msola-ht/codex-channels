import type { OperationUpdate } from "../conversation-core/index.js";

const maximumBufferedTurns = 100;
const maximumOperationsPerTurn = 100;

export type BufferedOperationKind = Extract<
  OperationUpdate["kind"],
  "mcpTool" | "dynamicTool" | "webSearch"
>;

export interface OperationUpdateSummary {
  records: readonly OperationUpdate[];
  counts: ReadonlyMap<BufferedOperationKind, number>;
  totalDurationMs?: number;
}

export interface BufferedOperationSummary<T> {
  target: T;
  summary: OperationUpdateSummary;
}

interface BufferedTurn<T> {
  target: T;
  records: Map<string, OperationUpdate>;
}

export class OperationUpdateBuffer<T> {
  private readonly turns = new Map<string, BufferedTurn<T>>();

  accept(turnKey: string, operation: OperationUpdate, target: T): boolean {
    if (!isBufferedOperation(operation)) {
      return false;
    }
    if (operation.status === "completed") {
      const existing = this.turns.get(turnKey);
      if (existing !== undefined) {
        if (
          !existing.records.has(operation.itemId)
          && existing.records.size >= maximumOperationsPerTurn
        ) {
          return false;
        }
        existing.records.set(operation.itemId, operation);
      } else if (this.turns.size < maximumBufferedTurns) {
        this.turns.set(turnKey, {
          target,
          records: new Map([[operation.itemId, operation]]),
        });
      } else {
        return false;
      }
    }
    return operation.status === "running" || operation.status === "completed";
  }

  take(turnKey: string): BufferedOperationSummary<T> | null {
    const buffered = this.turns.get(turnKey);
    this.turns.delete(turnKey);
    if (buffered === undefined || buffered.records.size === 0) {
      return null;
    }
    return {
      target: buffered.target,
      summary: summarizeOperationUpdates([...buffered.records.values()]),
    };
  }

  drain(): BufferedOperationSummary<T>[] {
    const summaries = [...this.turns.keys()]
      .flatMap((turnKey) => {
        const buffered = this.take(turnKey);
        return buffered === null ? [] : [buffered];
      });
    return summaries;
  }

  clear(): void {
    this.turns.clear();
  }
}

export function summarizeOperationUpdates(
  records: readonly OperationUpdate[],
): OperationUpdateSummary {
  const counts = new Map<BufferedOperationKind, number>();
  let totalDurationMs = 0;
  let hasDuration = false;
  for (const record of records) {
    if (!isBufferedOperation(record)) {
      continue;
    }
    counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
    if (record.durationMs !== undefined && record.durationMs > 0) {
      totalDurationMs += record.durationMs;
      hasDuration = true;
    }
  }
  return {
    records,
    counts,
    ...(hasDuration ? { totalDurationMs } : {}),
  };
}

export function operationSummaryRows(
  summary: OperationUpdateSummary,
): string[] {
  const labels: Record<BufferedOperationKind, string> = {
    mcpTool: "MCP 工具",
    dynamicTool: "动态工具",
    webSearch: "网页搜索",
  };
  return (["mcpTool", "dynamicTool", "webSearch"] as const)
    .flatMap((kind) => {
      const count = summary.counts.get(kind);
      return count === undefined ? [] : [`${labels[kind]}：${count} 次`];
    });
}

function isBufferedOperation(
  operation: OperationUpdate,
): operation is OperationUpdate & { kind: BufferedOperationKind } {
  return operation.kind === "mcpTool"
    || operation.kind === "dynamicTool"
    || operation.kind === "webSearch";
}
