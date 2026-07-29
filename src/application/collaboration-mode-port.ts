export type CollaborationModeKind = "default" | "plan";

export interface CollaborationModePreset {
  name: string;
  mode: CollaborationModeKind;
  model: string | null;
  effort: string | null;
}

export interface CollaborationModeQueryPort {
  listCollaborationModes(): Promise<CollaborationModePreset[]>;
}
