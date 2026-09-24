/** Accept help only for an exact public command path, before reading configuration. */
export function isCommandHelp(args, paths, usage) {
  if (!args.some((value) => value === "-h" || value === "--help")) return false;
  const flag = args.at(-1);
  const command = args.slice(0, -1);
  if ((flag === "-h" || flag === "--help")
    && paths.some((path) => path.length === command.length
      && path.every((value, index) => value === command[index]))) return true;
  throw new Error(usage);
}
