export type CollaborationModeKind = "default" | "plan";

export interface CollaborationModePreset {
  name: string;
  mode: CollaborationModeKind;
  model: string | null;
  effort: string | null;
}

export interface CollaborationModeQueryPort {
  listCollaborationModes(beforeSubmit?: () => void): Promise<CollaborationModePreset[]>;
}
