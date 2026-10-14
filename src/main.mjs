import { StorageClient } from './storage/client.mjs';
import { StudioUI } from './ui/studio.mjs';
import { StudioController } from './controller.mjs';

const ui = new StudioUI(document.querySelector('#app'));
const storage = new StorageClient();
const studio = new StudioController(storage, ui);
studio.init().catch(error => { console.error(error); ui.notify(`The studio could not open: ${error.message}`, 'error'); studio.state.busy = false; studio.state.error = error.message; studio.render(); });

// Updates stay pending while an existing studio is open. Make that state
// visible instead of silently leaving the user on an older cached interface.
// Never activate a waiting worker or reload while audio may be recording.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  globalThis.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), {
        scope: new URL('../', import.meta.url).pathname, updateViaCache: 'none',
      });
      const notice = ui.refs['update-notice'];
      const showWaiting = () => {
        notice.hidden = !registration.waiting;
        if (registration.waiting) notice.textContent = 'Studio update ready. Finish recording, then close every studio tab or app window and reopen. Your saved audio stays on this device.';
      };
      const watchInstalling = () => {
        registration.installing?.addEventListener('statechange', showWaiting);
        showWaiting();
      };
      registration.addEventListener('updatefound', watchInstalling);
      watchInstalling();
      let lastCheck = 0;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        showWaiting();
        if (Date.now() - lastCheck < 60000) return;
        lastCheck = Date.now();
        registration.update().then(showWaiting).catch(() => {});
      });
    } catch { /* Offline use and audio recording do not depend on update checks. */ }
  });
}
