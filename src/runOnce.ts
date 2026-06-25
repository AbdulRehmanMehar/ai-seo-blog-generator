import './config/forceIpv4.js'; // side-effect: must run before any network call
import { runPipelineOnce } from './scheduler/orchestrator.js';

await runPipelineOnce();
