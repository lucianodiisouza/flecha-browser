/** Native VSR controls, with processed-frame counts read each time the pane is shown. */
import type { SettingsApi, VsrSettings, VsrState } from '../../shared/types';

export function setupVsrPane(api: SettingsApi) {
  const pane = document.querySelector<HTMLElement>('.pane[data-pane="video"]')!;
  const form = document.getElementById('vsr-form') as HTMLFormElement;
  const controls = document.getElementById('vsr-controls') as HTMLFieldSetElement;
  const enabled = document.getElementById('vsr-enabled') as HTMLInputElement;
  const quality = document.getElementById('vsr-quality') as HTMLSelectElement;
  const height = document.getElementById('vsr-height') as HTMLInputElement;
  const status = document.getElementById('vsr-status')!;
  const frames = document.getElementById('vsr-frames')!;
  const output = document.getElementById('vsr-output')!;
  let reading = false;
  let writing = false;
  let stopped = false;
  let available = false;
  let idle: number | undefined;

  function render(state: VsrState, updateControls: boolean) {
    available = state.available;
    if (updateControls) {
      enabled.checked = state.enabled;
      quality.value = String(state.quality);
      height.value = String(state.maxOutputHeight);
    }
    controls.disabled = !state.available || writing;
    status.textContent = !state.available
      ? 'Native VSR is unavailable in this browser session.'
      : !state.enabled ? 'Off'
      : state.error ? `GPU scaling fallback: ${state.error}`
      : state.processedFrames === '0' ? 'Enabled, waiting for compatible video.' : 'Enabled';
    frames.textContent = `Enhanced frames in this GPU session: ${state.processedFrames}`;
    output.textContent = state.inputWidth
      ? `Last enhanced frame: ${state.inputWidth} × ${state.inputHeight} → ${state.outputWidth} × ${state.outputHeight}` : '';
  }

  function schedule() {
    if (idle !== undefined) cancelIdleCallback(idle);
    idle = undefined;
    if (stopped || pane.hidden || document.hidden || reading || writing) return;
    // One read each time the pane or page becomes visible, in idle time.
    idle = requestIdleCallback(() => { idle = undefined; void refresh(); });
  }

  async function refresh() {
    if (!api.getVsrState) {
      status.textContent = 'Native VSR is unavailable in this browser build.';
      return;
    }
    reading = true;
    try {
      const state = await api.getVsrState();
      // Settings are browser-wide and each change saves at once, so every read
      // brings the controls up to date with changes from other pages.
      if (!stopped && !writing) render(state, true);
    } catch (error) {
      status.textContent = String(error);
      controls.disabled = true;
    } finally {
      reading = false;
    }
  }

  async function save() {
    if (!api.setVsrSettings || writing || !form.reportValidity()) return;
    const level = Number(quality.value);
    if (level !== 1 && level !== 2 && level !== 3 && level !== 4) return;
    const settings: VsrSettings = { enabled: enabled.checked, quality: level, maxOutputHeight: height.valueAsNumber };
    writing = true;
    controls.disabled = true;
    try {
      const state = await api.setVsrSettings(settings);
      if (!stopped) render(state, true);
    } catch (error) {
      status.textContent = String(error);
    } finally {
      writing = false;
      controls.disabled = !available;
    }
  }

  form.addEventListener('change', () => void save());
  form.addEventListener('submit', (event) => { event.preventDefault(); void save(); });
  const observer = new MutationObserver(schedule);
  observer.observe(pane, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('focus', schedule);
  window.addEventListener('pagehide', () => {
    stopped = true;
    observer.disconnect();
    if (idle !== undefined) cancelIdleCallback(idle);
    document.removeEventListener('visibilitychange', schedule);
    window.removeEventListener('focus', schedule);
  }, { once: true });
  schedule();
}
