/** Account validation and recovery failures with stable, nonsensitive classifications. */
export class AccountManagementError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = "AccountManagementError";
    this.code = code;
    this.field = field;
  }
}
