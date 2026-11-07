/**
 * Search v2 UI: the opt-in 3D view inside a variant card. Nothing here runs until "Show in 3D" is pressed;
 * then the Studio's pair viewer (studio/embed/pair-viewer.js, Mol*) and the two GPCRdb models
 * (models/{active,inactive}/<gid>_<state>.pdb.gz) are fetched, the residue is framed and its contacts above
 * the threshold are drawn: red where stronger in the active model, blue where stronger in the inactive one.
 * The same embed and model files as the report pages' 3D view (static/js/viewer3d.js).
 *
 * @module search-ui/view3d
 */

const absolute = (url) => new URL(url, document.baseURI).href;

/**
 * Mount the viewer into `pane` for one result.
 * @param {HTMLElement} pane
 * @param {{gid: string, pos: number, contacts: object[], models: string, studio: string, status?: (text: string, state: string) => void}} cfg
 * @returns {Promise<object>} the viewer handle
 */
export async function mount3d(pane, cfg) {
  const say = cfg.status ?? (() => {});
  say('Loading the 3D viewer', 'loading');
  let mod;
  try {
    mod = await import(absolute(`${cfg.studio}embed/pair-viewer.js`));
  } catch (e) {
    say('The 3D viewer is not available in this build.', 'error');
    throw e;
  }
  const contacts = (cfg.contacts ?? []).map((c) => ({ a: c.a, b: c.b, delta: c.delta, active: c.active, inactive: c.inactive, passes: true }));
  const handle = mod.mountPairViewer(pane, {
    activeUrl: absolute(`${cfg.models}active/${cfg.gid}_active.pdb.gz`),
    inactiveUrl: absolute(`${cfg.models}inactive/${cfg.gid}_inactive.pdb.gz`),
    highlight: cfg.pos ? [cfg.pos] : [],
    contacts,
    contactOptions: { show: 'passing', top: 25, sign: 'both' },
    onError: (err) => say(err?.message ? err.message : 'The 3D view could not start.', 'error'),
  });
  if (cfg.pos && handle.focus) handle.focus(cfg.pos);
  try {
    const r = await handle.ready;
    say(`Models superposed on ${r?.n ?? 'all'} Cα atoms; ${contacts.length} contact${contacts.length === 1 ? '' : 's'} drawn.`, 'ready');
  } catch (e) {
    say('The models for this receptor are not hosted in this build.', 'error');
  }
  return handle;
}
