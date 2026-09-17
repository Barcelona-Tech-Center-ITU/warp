'use strict';

import html from './html/index.html';
import * as bootstrap from '../app/bootstrap.js';
import { mount as mountCapacity } from './capacity.js';

export { html };

export async function mount(ctx) {
  // Two <img>s (CSS shows one per theme) because the logo is raster artwork:
  // the colour lockup is invisible on the dark page, the white knockout on the
  // light one. URLs come from warpGlobals so they follow the mount prefix.
  var logo = ctx.root.querySelector('#index-logo');
  if (logo) logo.src = window.warpGlobals.URLs.logo;
  var logoDark = ctx.root.querySelector('#index-logo-dark');
  if (logoDark) logoDark.src = window.warpGlobals.URLs.logoWhite;

  // Dashboard XHR is independent of bootstrap; overlap the two so the intro
  // cards and occupancy numbers arrive together.
  var capacityReady = mountCapacity(ctx);

  // The landing page explains the tool, so it is never skipped — the default
  // plan preference turns into a shortcut button here instead of an automatic
  // redirect. data.plans is the accessible set from /xhr/bootstrap, so the
  // `some` check guards against both a deleted and an inaccessible default.
  var data = await bootstrap.get();
  var btn = ctx.root.querySelector('#index_default_plan_btn');
  if (btn && data.defaultPlan != null) {
    var plan = data.plans.find(function (p) { return p.id === data.defaultPlan; });
    if (plan) {
      btn.href = window.warpGlobals.URLs['plan'].replace('__PID__', plan.id);
      btn.textContent = TR('home.OpenDefaultPlan', {plan: plan.name});
      btn.style.display = '';
    }
  }

  await capacityReady;
}

export default { html, mount };
