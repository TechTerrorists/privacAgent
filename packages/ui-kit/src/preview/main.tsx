import { render } from 'preact';
import { App } from './App.js';

const container = document.getElementById('pa-preview-root');

if (container) {
  render(<App />, container);
}
