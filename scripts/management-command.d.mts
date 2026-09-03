export function enableManagement(
  environment?: NodeJS.ProcessEnv,
  output?: NodeJS.WritableStream,
): {
  path: string;
  created: boolean;
  rotated: boolean;
  credential: string | null;
};
