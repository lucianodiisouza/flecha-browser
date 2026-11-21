/** Loads a Settings pane once, or lets the next visit retry failed setup. */
export function lazySettingsPane<Module>(load: () => Promise<Module>, setup: (module: Module) => void | Promise<void>) {
  let pending: Promise<void> | undefined;
  let error: HTMLElement | undefined;

  return (pane: HTMLElement, title: string) => pending ??= (async () => {
    let imported = false;
    try {
      const module = await load();
      imported = true;
      await setup(module);
    } catch (cause) {
      console.error(`Could not load the ${title} settings pane`, cause);
      if (imported) pending = undefined;
      // Chromium can cache a failed import until the Settings document reloads.
      error?.remove();
      error = document.createElement('div');
      error.className = 'pane-load-error lead';
      error.setAttribute('role', 'alert');
      error.textContent = `Could not load ${title}.`;
      if (imported) {
        error.append(' Open another pane, then return to try again.');
      } else {
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.textContent = 'Reload Settings';
        reload.addEventListener('click', () => location.reload());
        error.append(' ', reload);
      }
      pane.classList.add('pane-load-failed');
      pane.prepend(error);
      return;
    }
    pane.classList.remove('pane-load-failed');
    error?.remove();
    error = undefined;
  })();
}
