import './config/forceIpv4.js'; // side-effect: must run before any network call
import { startScheduler } from './scheduler/scheduler.js';

startScheduler();
