#!/usr/bin/env node

import { runVideoMcp } from "../scripts/video-analysis-mcp.mjs";

await runVideoMcp(process.argv.slice(2));
