/** Types for request-floor.mjs (BUG-187) — the ledger shared by the broker and the responder-only bridge. */
export declare const FLOOR_REFUSAL_REASON: string;
export declare function laneOf(request: unknown): string | null;
export declare function refusalFrame(requestId: unknown, request: unknown, reason?: string): Record<string, unknown>;
export declare function floorGraceFromEnv(env?: Record<string, string | undefined>): { hook_callback: number; can_use_tool: number; other: number };
export declare const HANDOVER_TIMEOUT_MS: number;
export declare function laneBlockMsFromEnv(env?: Record<string, string | undefined>): number;
export interface FloorLaneSnapshot {
  id: string;
  refusals: number;
  blockedSince: string | null;
  stopRequestedAt: string | null;
  stoppedAt: string | null;
  stopUnconfirmed: boolean;
}
export declare class RequestFloor {
  constructor(o: {
    grace?: { hook_callback: number; can_use_tool: number; other: number };
    laneBlockMs?: number;
    stopConfirmMs?: number;
    now?: () => number;
    write: (frame: Record<string, unknown>) => void;
    stopLane?: (laneId: string) => void;
    onChange?: () => void;
    log?: (msg: string) => void;
  });
  refusals: number;
  /** false = the id is already settled; the owner must not forward this replay. */
  onCliRequest(frame: Record<string, unknown>, clientId: unknown): boolean;
  isSettled(requestId: unknown): boolean;
  onCliCancel(requestId: unknown): void;
  onClientResponse(requestId: unknown, clientId: unknown): boolean;
  onClientDetached(clientId: unknown): void;
  onClientInitialize(clientId: unknown, initRequestId: string): void;
  onInitResponse(initRequestId: string, pendingIds: unknown[] | null, success: boolean): unknown;
  onAdopted(): void;
  onLaneTerminal(laneId: string): void;
  tick(): void;
  snapshot(): { pending: { unowned: number; owned: number; handover: number }; refusals: number; droppedLateResponses: number; lanes: FloorLaneSnapshot[] };
  hasPending(): boolean;
  hasOwned(): boolean;
  stateOf(requestId: unknown): string | null;
  static isTerminal(state: string): boolean;
}
