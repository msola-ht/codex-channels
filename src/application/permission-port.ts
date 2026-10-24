export interface PermissionProfileOption {
  id: string;
  description: string | null;
  allowed: boolean;
}

export interface PermissionQueryPort {
  listPermissionProfiles(cwd: string, beforeSubmit?: () => void): Promise<PermissionProfileOption[]>;
}
