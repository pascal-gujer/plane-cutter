/*
 * main.js – wires the pieces together once the page is ready.
 */
(function () {
  'use strict';
  const PC = (globalThis.PlaneCutter = globalThis.PlaneCutter || {});

  function boot() {
    const app = PC.app;
    PC.controls.create(
      { panel: document.getElementById('panel'), toolbar: document.getElementById('toolbar'), statusbar: document.getElementById('statusbar') },
      app,
    );
    PC.editor.createEditor(document.getElementById('editor'), app);
    document.getElementById('topbar-export').addEventListener('click', () => app.actions.exportSheet());
    app.init();
    const v = document.getElementById('version');
    if (v && PC.version) v.textContent = PC.version;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
