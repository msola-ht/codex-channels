export class ConfigManagementError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = "ConfigManagementError";
    this.code = code;
    this.field = field;
  }
}

export function invalidSetting(field, code, message) {
  return new ConfigManagementError(code, field, message);
}
