/**
 * Extension buttons in the sidebar. Flecha hides Chromium's toolbar, so the frame page shows
 * the toolbar's extension actions instead (patch 0056) and runs them: a popup opens below its
 * button, and right-click shows the extension's own menu (options, pin, remove). The puzzle
 * button opens Chromium's extensions menu there (patch 0071).
 */
import { toast } from './settingsUi';

const surface = document.documentElement.dataset.surface;
if (surface === 'window' && typeof chrome.flechaPrivate?.getExtensionActions === 'function') void showExtensionActions();

async function showExtensionActions() {
  const windowId = await chrome.flechaPrivate.getWindowId();
  const list = document.getElementById('extensions')!;
  const pins = document.getElementById('extension-pins')!;
  const toggle = document.getElementById('btn-toggle-extension-pins')!;
  const menuButton = document.getElementById('btn-extensions')!;
  const anchor = (button: HTMLElement) => {
    const r = button.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  };
  // A browser without patch 0071 has no extensions menu to show.
  const hasMenu = typeof chrome.flechaPrivate.showExtensionsMenu === 'function';
  let showUnpinned = !hasMenu;
  menuButton.hidden = !hasMenu;
  let collapsed = false;
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    pins.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });
  // Each action keeps its button, updated in place: a button replaced between a press and its
  // release would lose the click, and badges can change many times a second.
  const buttons = new Map<string, HTMLButtonElement>();
  const buttonFor = (id: string) => {
    const known = buttons.get(id);
    if (known) return known;
    const button = Object.assign(document.createElement('button'), { className: 'ext-action' });
    // A disabled action shows the extension's menu at its button, as on the toolbar.
    button.addEventListener('click', () => void chrome.flechaPrivate.runExtensionAction(windowId, id, anchor(button)));
    button.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void chrome.flechaPrivate.showExtensionActionMenu(windowId, id, anchor(button));
    });
    buttons.set(id, button);
    return button;
  };
  const show = (action: chrome.flechaPrivate.ExtensionAction) => {
    const button = buttonFor(action.id);
    button.classList.toggle('disabled', !action.enabled);
    button.dataset.tip = action.tooltip || action.name;
    button.setAttribute('aria-label', action.name);
    let img = button.querySelector('img');
    if (!action.icon) img?.remove();
    else if (!img) button.append(Object.assign(document.createElement('img'), { src: action.icon, alt: '' }));
    else if (img.src !== action.icon) img.src = action.icon;
    return button;
  };
  // One read at a time, and one more if something changed meanwhile.
  let reading: Promise<void> | undefined;
  let again = false;
  const refresh = () => {
    if (reading) return void (again = true);
    reading = chrome.flechaPrivate
      .getExtensionActions(windowId)
      // Flecha's own action (the stock-Chromium side panel's button) is this sidebar.
      .then((all) => all.filter((action) => action.id !== chrome.runtime.id))
      .then((actions) => {
        for (const id of buttons.keys()) if (!actions.some((action) => action.id === id)) buttons.delete(id);
        const row = actions.filter((action) => showUnpinned || action.pinned).map(show);
        // Moved only when the order changed, so a press on a button stays on it.
        if (row.length !== pins.children.length || row.some((button, i) => pins.children[i] !== button)) pins.replaceChildren(...row);
        toggle.hidden = showUnpinned || !row.length;
        list.hidden = !actions.length;
      })
      .catch((err) => console.error('Flecha shell: extension actions failed', err))
      .finally(() => {
        reading = undefined;
        if (again) {
          again = false;
          refresh();
        }
      });
  };
  if (hasMenu) menuButton.addEventListener('click', async () => {
    const button = menuButton as HTMLButtonElement;
    button.disabled = true;
    try {
      await chrome.flechaPrivate.showExtensionsMenu(windowId, anchor(button));
      if (showUnpinned) {
        showUnpinned = false;
        refresh();
      }
    } catch {
      showUnpinned = true;
      collapsed = false;
      pins.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      refresh();
      toast('Couldn’t open the Extensions menu. Extensions are shown in the sidebar.');
    } finally {
      button.disabled = false;
    }
  });
  chrome.flechaPrivate.onExtensionActionsChanged.addListener((id) => id === windowId && refresh());
  // Icons and badges are per tab.
  chrome.tabs.onActivated.addListener((info) => info.windowId === windowId && refresh());
  refresh();
}
