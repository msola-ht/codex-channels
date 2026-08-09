import { writeCliMessage } from "../runtime/cli-presentation.mjs";

const kind = process.argv[2];
const message = process.argv.slice(3).join(" ");
if (
  !["success", "failure", "note", "remediation"].includes(kind)
  || message.length === 0
) {
  throw new Error(
    "用法：cli-status.mjs <success|failure|note|remediation> <消息>",
  );
}
writeCliMessage(kind, message);
