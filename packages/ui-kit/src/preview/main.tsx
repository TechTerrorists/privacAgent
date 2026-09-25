import { render } from 'preact';
import './preview.css';
import { App } from './App.js';

const container = document.getElementById('pa-preview-root');

if (container) {
  render(<App />, container);
}
