import { execFileSync } from "node:child_process";

export function parseChangedFiles(output) {
  if (output && !output.endsWith("\0")) throw new Error("Git 变更路径清单不完整");
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) throw new Error("Git 变更路径清单不完整");
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (!/^[ACDMTUXB]$/u.test(status) || !path) throw new Error("Git 变更路径清单无效");
    changes.push({ status, path });
  }
  return changes;
}

export function changedFiles(args, cwd = process.cwd()) {
  return parseChangedFiles(execFileSync("git", [
    "diff", "--name-status", "--no-renames", "-z", ...args,
  ], { cwd, encoding: "utf8" }));
}
