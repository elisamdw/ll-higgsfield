#!/usr/bin/env node
import {runStorylab} from './storylab/lib/cli.mjs';

runStorylab().catch(error => {
  console.error(`storylab: ${error.message}`);
  process.exitCode = 1;
});
