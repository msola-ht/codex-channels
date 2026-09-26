export function writeResponsesContextFollowers(updates: Map<string,string>, environment: NodeJS.ProcessEnv, originals?: Map<string,string>, targetModel?: string): boolean;
export function recoverResponsesContextSync(environment: NodeJS.ProcessEnv, id: string, action: "keep" | "rollback"): boolean;
export function listResponsesContextFollowers(environment: NodeJS.ProcessEnv, model?: string): Array<{providerId:string; model:string; contextWindow:number}>;
export function clinePassFollowsDeepseekContext(environment: NodeJS.ProcessEnv): boolean;
