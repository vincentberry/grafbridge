const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="grafbridge-token"]').content;
let activeJob, uploading = false, scanning = false, titleCount = 0, missingFonts = false;
let historySignature = '';
function showView(view) {
  const historyView = view === 'history';
  $('conversion-view').hidden = historyView;
  $('history-view').hidden = !historyView;
  for (const link of document.querySelectorAll('.nav[data-view]')) {
    const active = link.dataset.view === (historyView ? 'history' : 'conversion');
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  window.history.replaceState(null, '', historyView ? '#history' : '#conversion');
  window.scrollTo({top:0});
}
for (const link of document.querySelectorAll('.nav[data-view]')) {
  link.onclick = event => { event.preventDefault(); showView(link.dataset.view); };
}
window.addEventListener('hashchange', () => showView(location.hash === '#history' ? 'history' : 'conversion'));
showView(location.hash === '#history' ? 'history' : 'conversion');
function syncConvert() { $('convert').disabled = !titleCount || missingFonts || !!activeJob || uploading || scanning; }
function showFonts(requirements) {
  const box = $('font-status'); box.replaceChildren();
  missingFonts = !!requirements?.missing?.length;
  box.classList.toggle('missing', missingFonts);
  if (missingFonts) {
    const heading = document.createElement('strong'); heading.textContent = 'Missing fonts — select their font folder before converting.';
    const list = document.createElement('ul');
    for (const item of requirements.missing) {
      const row = document.createElement('li'); row.textContent = `${item.family}: ${item.files.join(' or ')}`; list.append(row);
    }
    box.append(heading, list);
  } else box.textContent = requirements ? (requirements.required.length ? `Fonts ready: ${requirements.required.join(', ')}.` : 'No external fonts required.') : 'Select titles to check their required fonts.';
  syncConvert();
}
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
async function api(path, data) {
  const response = await fetch(path, { method: 'POST', headers: {'Content-Type': 'application/json', 'X-GrafBridge-Token': token}, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) { const error = new Error(result.error); error.fonts = result.fonts; throw error; } return result;
}
function showTitles(items) {
  titleCount = items.length;
  $('titles').replaceChildren(); $('title').replaceChildren(new Option('All titles in the folder', ''));
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'file';
    const name = document.createElement('span'), size = document.createElement('span');
    name.textContent = item.name; size.textContent = `${(item.bytes / 1048576).toFixed(1)} MiB`; size.className = 'muted';
    row.append(name, size); $('titles').append(row); $('title').add(new Option(item.name, item.name));
  }
  syncConvert();
  if (!items.length) $('titles').textContent = 'No .gtzip files found.';
}
$('source').oninput = () => { showTitles([]); showFonts(null); };
async function checkFonts() {
  if (!titleCount || uploading || scanning) return;
  scanning = true; syncConvert();
  try { const result = await api('/api/scan', {source:$('source').value, fonts:$('fonts').value, title:$('title').value}); showFonts(result.fonts); }
  catch (error) { message(error.message, true); showTitles([]); }
  finally { scanning = false; syncConvert(); }
}
$('title').onchange = checkFonts;
$('fonts').onchange = checkFonts;
$('scan').onclick = async () => {
  if (uploading || scanning) return; scanning = true; $('scan').disabled = true;
  try { const result = await api('/api/scan', { source: $('source').value, fonts: $('fonts').value }); showTitles(result.titles); showFonts(result.fonts); message(`${result.titles.length} title(s) found.`); }
  catch (error) { showTitles([]); message(error.message, true); }
  finally { scanning = false; $('scan').disabled = false; syncConvert(); }
};
async function upload(files) {
  if (uploading || activeJob || scanning) return;
  if (!files.length) return;
  if (files.some(file => !/\.gtzip$/i.test(file.name))) return message('Select only .gtzip files.', true);
  if (files.some(file => file.size > 256 * 1048576)) return message('Each title must be 256 MiB or smaller.', true);
  uploading = true; $('convert').disabled = true; $('scan').disabled = true; $('source').disabled = true;
  const batch = crypto.randomUUID().replaceAll('-', '');
  try {
    let result;
    for (let i = 0; i < files.length; i++) {
      message(`Importing ${files[i].name} (${i + 1}/${files.length})…`);
      const response = await fetch(`/api/upload?batch=${batch}&name=${encodeURIComponent(files[i].name)}`, { method: 'POST', headers: {'X-GrafBridge-Token': token}, body: files[i] });
      result = await response.json(); if (!response.ok) throw new Error(result.error);
    }
    $('source').value = result.source; showTitles(result.titles); message(`${result.titles.length} title(s) ready to convert.`);
  } catch (error) { showTitles([]); message(error.message, true); }
  finally { uploading = false; $('scan').disabled = false; $('source').disabled = false; $('files').value = ''; await checkFonts(); syncConvert(); }
}
$('files').onchange = event => upload(Array.from(event.target.files));
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('over'); });
for (const name of ['dragleave', 'drop']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.remove('over'); });
$('dropzone').addEventListener('drop', event => upload(Array.from(event.dataTransfer.files)));
$('convert').onclick = async () => {
  $('convert').disabled = true;
  try { const result = await api('/api/convert', { source: $('source').value, fonts: $('fonts').value, title: $('title').value }); activeJob = result.id; message('Conversion started.'); await refresh(); }
  catch (error) { if (error.fonts) showFonts(error.fonts); message(error.message, true); syncConvert(); }
};
function resultCard(job) {
  const card = document.createElement('article'); card.className = 'result';
  card.dataset.jobId = job.id;
  const image = document.createElement('img'); image.src = '/logo.svg'; image.alt = '';
  const info = document.createElement('div'), title = document.createElement('strong'), subtitle = document.createElement('small');
  const items = job.report.templates;
  title.textContent = items.length === 1 ? items[0].name : `${items.length} titles converted`;
  subtitle.textContent = `${(items.reduce((n, item) => n + item.bytes, 0) / 1048576).toFixed(1)} MiB · OGraf ZIP + animated preview`;
  info.append(title, subtitle); const link = document.createElement('a'); link.href = job.preview; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open previews ↗'; card.append(image, info, link);
  const warnings = items.flatMap(item => (item.warnings || []).filter(warning => warning.type !== 'licence-police-absente').map(warning => `${item.name}: ${warning.detail || warning.type}`));
  if (warnings.length) {
    const details = document.createElement('details'), summary = document.createElement('summary'), list = document.createElement('ul'); details.dataset.kind = 'warnings'; summary.textContent = `${warnings.length} warning(s) to review`;
    for (const warning of warnings) { const li = document.createElement('li'); li.textContent = warning; list.append(li); } details.append(summary, list); card.append(details);
  }
  const missingLicenses = [...new Set(items.flatMap(item => (item.fontLicenses || []).filter(font => !font.included).map(font => font.family)))];
  const legacyLicenseNote = items.some(item => (item.warnings || []).some(warning => warning.type === 'licence-police-absente'));
  if (missingLicenses.length || legacyLicenseNote) {
    const details = document.createElement('details'), summary = document.createElement('summary'), note = document.createElement('p');
    details.className = 'license-note'; details.dataset.kind = 'licenses'; summary.textContent = 'Optional font license files';
    note.textContent = 'The fonts are available and conversion succeeded. License text files were not included' + (missingLicenses.length ? ` for ${missingLicenses.join(', ')}` : '') + '. These are optional documentation files, not missing fonts.';
    details.append(summary, note); card.append(details);
  }
  return card;
}
function renderHistory(done) {
  const signature = JSON.stringify(done.map(job => [job.id, job.report]));
  if (signature === historySignature) return;
  historySignature = signature;
  if (!done.length) return;
  const existing = new Map([...$('results').querySelectorAll('[data-job-id]')].map(card => [card.dataset.jobId, card]));
  $('results').querySelector('.empty')?.remove();
  for (let index = 0; index < done.length; index++) {
    const job = done[index];
    let card = existing.get(job.id);
    const reportSignature = JSON.stringify(job.report);
    if (!card || card.reportSignature !== reportSignature) {
      const openPanels = new Set([...card?.querySelectorAll('details[open]') || []].map(panel => panel.dataset.kind));
      const replacement = resultCard(job); replacement.reportSignature = reportSignature;
      for (const panel of replacement.querySelectorAll('details')) panel.open = openPanels.has(panel.dataset.kind);
      if (card) card.replaceWith(replacement); card = replacement;
    }
    if ($('results').children[index] !== card) $('results').insertBefore(card, $('results').children[index] || null);
    existing.delete(job.id);
  }
  for (const obsolete of existing.values()) obsolete.remove();
}
async function refresh() {
  try {
    const response = await fetch('/api/jobs'); if (!response.ok) throw new Error('The local engine is unavailable.'); const jobs = await response.json();
    const ongoing = jobs.find(job => ['queued', 'running'].includes(job.status)); if (ongoing && !activeJob) activeJob = ongoing.id;
    const done = jobs.filter(job => job.status === 'done').sort((a,b) => (b.createdAt || b.id).localeCompare(a.createdAt || a.id)); $('history-count').textContent = done.length; $('total').textContent = `${done.length} conversion(s)`;
    renderHistory(done);
    const current = jobs.find(job => job.id === activeJob);
    if (current) {
      $('progress').hidden = false; $('log').textContent = current.log || 'Preparing resources…';
      $('progress-title').textContent = current.status === 'done' ? 'Conversion complete' : current.status === 'error' ? 'Conversion failed' : 'Converting';
      $('progress-state').textContent = {done: 'DONE', error: 'ERROR', queued: 'PREPARING', running: 'IN PROGRESS'}[current.status];
      if (['done', 'error'].includes(current.status)) { message(current.error || 'Your packages are ready. Open a preview to test animations and download the ZIP files.', current.status === 'error'); activeJob = null; syncConvert(); if (current.status === 'done') showView('history'); }
    }
    if (ongoing) $('convert').disabled = true;
  } catch (error) { message(`Connection interrupted: ${error.message}`, true); }
}
refresh(); setInterval(refresh, 1500);

if (window.grafbridge) {
  for (const id of ['source', 'fonts']) {
    const button = $(`browse-${id}`); button.hidden = false;
    button.onclick = async () => {
      try {
        const directory = await window.grafbridge.selectDirectory();
        if (!directory) return;
        $(id).value = directory;
        if (id === 'source') $('scan').click();
        else await checkFonts();
      } catch (error) { message(error.message, true); }
    };
  }
}
