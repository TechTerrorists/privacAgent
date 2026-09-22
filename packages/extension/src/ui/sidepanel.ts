/**
 * Side panel (Chrome) / sidebar (Firefox) entry point.
 *
 * A-10 mounts the real shell here — task input, action list, stop button and
 * the settings route — using the UI kit from F-01. For A-01 this only proves
 * the HTML entry builds and loads in both browsers.
 */

const root = document.querySelector('#root');

if (root) {
  const status = document.createElement('p');
  status.textContent = `Build target: ${__BROWSER__}`;
  root.append(status);
}

export {};
