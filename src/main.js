/**
 * Entry point.
 *
 * The registry imports are load-bearing: importing a module is what registers
 * its filter operators and content renderers. Anything you add later gets
 * picked up by adding one import here.
 */

import '../src/core/query.js';        // registers the filter operators
import '../src/content/renderers.js'; // registers the content block types
import { App } from './ui/app.js';

const app = new App(document.body);
app.start();

// Exposed for tinkering from the console — this is a tool you are expected to
// take apart.
globalThis.mindmap = app;
