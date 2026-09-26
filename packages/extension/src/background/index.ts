/**
 * Background entry point (Chrome service worker / Firefox event page).
 *
 * Scope for A-01 is only that this builds and loads in both browsers. The
 * background context stays thin by design: routing (A-03), screenshot capture
 * (A-07) and the single network chokepoint plus Egress Guard (A-06, D-11) land
 * here in later features, and no other context is allowed to hold a network
 * client.
 */

import browser from 'webextension-polyfill';
import { installRegistryNavigation } from './registry-navigation.js';

installRegistryNavigation();

const BUILD_TARGET = __BROWSER__;

browser.runtime.onInstalled.addListener(() => {
  console.info(`[privacAgent] background ready (${BUILD_TARGET})`);
});
