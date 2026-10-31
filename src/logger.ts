// src/logger.ts
import fs from 'fs/promises';
import path from 'path';

export interface TraceEvent {
  timestamp: string;
  run_id: string;
  state: string;
  action: string;
  tool_name?: string;
  tool_args?: any;
  tool_result?: any;
  latency_ms?: number;
  tokens_used?: { input: number; output: number };
}

const TRACE_PATH = path.join(__dirname, '../data/traces.jsonl');

export class TraceLogger {
  private runId: string;

  constructor() {
    this.runId = `run_${Date.now()}`;
  }

  public async log(event: Omit<TraceEvent, 'timestamp' | 'run_id'>) {
    const fullEvent: TraceEvent = {
      timestamp: new Date().toISOString(),
      run_id: this.runId,
      ...event
    };

    // Sanitize any potential secrets or sensitive keys
    const sanitized = JSON.parse(JSON.stringify(fullEvent), (key, value) => {
      if (['api_key', 'secret', 'password', 'token'].includes(key.toLowerCase())) {
        return '[REDACTED]';
      }
      return value;
    });

    await fs.mkdir(path.dirname(TRACE_PATH), { recursive: true });
    await fs.appendFile(TRACE_PATH, JSON.stringify(sanitized) + '\n');
  }

  public getRunId(): string {
    return this.runId;
  }
}