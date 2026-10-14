import { StorageClient } from './storage/client.mjs';
import { StudioUI } from './ui/studio.mjs';
import { StudioController } from './controller.mjs';

const ui = new StudioUI(document.querySelector('#app'));
const storage = new StorageClient();
const studio = new StudioController(storage, ui);
studio.init().catch(error => { console.error(error); ui.notify(`The studio could not open: ${error.message}`, 'error'); studio.state.busy = false; studio.state.error = error.message; studio.render(); });

// App-shell caching is installed only after a successful load. Updating never reloads a take.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  globalThis.addEventListener('load', () => navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).pathname }).catch(() => {}));
}
