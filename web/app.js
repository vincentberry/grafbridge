const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="grafbridge-token"]').content;
let activeJob, uploading = false, scanning = false, titleCount = 0, missingFonts = false;
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
  const image = document.createElement('img'); image.src = '/logo.svg'; image.alt = '';
  const info = document.createElement('div'), title = document.createElement('strong'), subtitle = document.createElement('small');
  const items = job.report.templates;
  title.textContent = items.length === 1 ? items[0].name : `${items.length} titles converted`;
  subtitle.textContent = `${(items.reduce((n, item) => n + item.bytes, 0) / 1048576).toFixed(1)} MiB · OGraf ZIP + animated preview`;
  info.append(title, subtitle); const link = document.createElement('a'); link.href = job.preview; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open previews ↗'; card.append(image, info, link);
  const warnings = items.flatMap(item => (item.warnings || []).map(warning => `${item.name} : ${warning.detail || warning.type}`));
  if (warnings.length) {
    const details = document.createElement('details'), summary = document.createElement('summary'), list = document.createElement('ul'); summary.textContent = `${warnings.length} warning(s) to review`;
    for (const warning of warnings) { const li = document.createElement('li'); li.textContent = warning; list.append(li); } details.append(summary, list); card.append(details);
  }
  return card;
}
async function refresh() {
  try {
    const response = await fetch('/api/jobs'); if (!response.ok) throw new Error('The local engine is unavailable.'); const jobs = await response.json();
    const ongoing = jobs.find(job => ['queued', 'running'].includes(job.status)); if (ongoing && !activeJob) activeJob = ongoing.id;
    const done = jobs.filter(job => job.status === 'done').reverse(); $('history-count').textContent = done.length; $('total').textContent = `${done.length} conversion(s)`;
    if (done.length) $('results').replaceChildren(...done.map(resultCard));
    const current = jobs.find(job => job.id === activeJob);
    if (current) {
      $('progress').hidden = false; $('log').textContent = current.log || 'Preparing resources…';
      $('progress-title').textContent = current.status === 'done' ? 'Conversion complete' : current.status === 'error' ? 'Conversion failed' : 'Converting';
      $('progress-state').textContent = {done: 'DONE', error: 'ERROR', queued: 'PREPARING', running: 'IN PROGRESS'}[current.status];
      if (['done', 'error'].includes(current.status)) { message(current.error || 'Your packages are ready. Open a preview to test animations and download the ZIP files.', current.status === 'error'); activeJob = null; syncConvert(); }
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
