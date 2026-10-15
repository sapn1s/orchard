export type ParsedRemote = { kind: 'local'; path: string } | { kind: 'network'; key: string };
/** THE remote parser (FEAT-164). null = unparseable or refused: the caller must refuse. */
export function parseRemote(u: unknown, opts?: { base?: string }): ParsedRemote | null;
