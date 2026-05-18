export const SWARM_ROLES = ["orchestrator", "coder", "researcher", "reviewer"] as const;
export type SwarmRole = typeof SWARM_ROLES[number];

export interface SwarmTaskOptions {
  role: SwarmRole;
  taskDescription: string;
  context?: string;
}

export interface SwarmResult {
  role: SwarmRole;
  output: string;
  success: boolean;
}
