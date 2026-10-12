const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="grafbridge-token"]').content;
let activeJob, uploading = false, scanning = false;
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
async function api(path, data) {
  const response = await fetch(path, { method: 'POST', headers: {'Content-Type': 'application/json', 'X-GrafBridge-Token': token}, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
function showTitles(items) {
  $('titles').replaceChildren(); $('title').replaceChildren(new Option('Tous les titres du dossier', ''));
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'file';
    const name = document.createElement('span'), size = document.createElement('span');
    name.textContent = item.name; size.textContent = `${(item.bytes / 1048576).toFixed(1)} Mio`; size.className = 'muted';
    row.append(name, size); $('titles').append(row); $('title').add(new Option(item.name, item.name));
  }
  $('convert').disabled = !items.length || !!activeJob;
  if (!items.length) $('titles').textContent = 'Aucun fichier .gtzip trouvé.';
}
$('source').oninput = () => { showTitles([]); };
$('scan').onclick = async () => {
  if (uploading || scanning) return; scanning = true; $('scan').disabled = true;
  try { const result = await api('/api/scan', { source: $('source').value }); showTitles(result.titles); message(`${result.titles.length} titre(s) trouvé(s).`); }
  catch (error) { showTitles([]); message(error.message, true); }
  finally { scanning = false; $('scan').disabled = false; }
};
async function upload(files) {
  if (uploading || activeJob || scanning) return;
  if (!files.length) return;
  if (files.some(file => !/\.gtzip$/i.test(file.name))) return message('Sélectionnez uniquement des fichiers .gtzip.', true);
  if (files.some(file => file.size > 256 * 1048576)) return message('Chaque titre doit faire au maximum 256 Mio.', true);
  uploading = true; $('convert').disabled = true; $('scan').disabled = true; $('source').disabled = true;
  const batch = crypto.randomUUID().replaceAll('-', '');
  try {
    let result;
    for (let i = 0; i < files.length; i++) {
      message(`Import de ${files[i].name} (${i + 1}/${files.length})…`);
      const response = await fetch(`/api/upload?batch=${batch}&name=${encodeURIComponent(files[i].name)}`, { method: 'POST', headers: {'X-GrafBridge-Token': token}, body: files[i] });
      result = await response.json(); if (!response.ok) throw new Error(result.error);
    }
    $('source').value = result.source; showTitles(result.titles); message(`${result.titles.length} titre(s) prêt(s) à convertir.`);
  } catch (error) { showTitles([]); message(error.message, true); }
  finally { uploading = false; $('scan').disabled = false; $('source').disabled = false; $('files').value = ''; }
}
$('files').onchange = event => upload(Array.from(event.target.files));
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('over'); });
for (const name of ['dragleave', 'drop']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.remove('over'); });
$('dropzone').addEventListener('drop', event => upload(Array.from(event.dataTransfer.files)));
$('convert').onclick = async () => {
  $('convert').disabled = true;
  try { const result = await api('/api/convert', { source: $('source').value, fonts: $('fonts').value, title: $('title').value }); activeJob = result.id; message('Conversion lancée.'); await refresh(); }
  catch (error) { message(error.message, true); $('convert').disabled = false; }
};
function resultCard(job) {
  const card = document.createElement('article'); card.className = 'result';
  const image = document.createElement('img'); image.src = '/logo.svg'; image.alt = '';
  const info = document.createElement('div'), title = document.createElement('strong'), subtitle = document.createElement('small');
  const items = job.report.templates;
  title.textContent = items.length === 1 ? items[0].name : `${items.length} titres convertis`;
  subtitle.textContent = `${(items.reduce((n, item) => n + item.bytes, 0) / 1048576).toFixed(1)} Mio · ZIP OGraf + aperçu animé`;
  info.append(title, subtitle); const link = document.createElement('a'); link.href = job.preview; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Ouvrir les aperçus ↗'; card.append(image, info, link);
  const warnings = items.flatMap(item => (item.warnings || []).map(warning => `${item.name} : ${warning.detail || warning.type}`));
  if (warnings.length) {
    const details = document.createElement('details'), summary = document.createElement('summary'), list = document.createElement('ul'); summary.textContent = `${warnings.length} avertissement(s) à consulter`;
    for (const warning of warnings) { const li = document.createElement('li'); li.textContent = warning; list.append(li); } details.append(summary, list); card.append(details);
  }
  return card;
}
async function refresh() {
  try {
    const response = await fetch('/api/jobs'); if (!response.ok) throw new Error('Serveur local indisponible.'); const jobs = await response.json();
    const ongoing = jobs.find(job => ['queued', 'running'].includes(job.status)); if (ongoing && !activeJob) activeJob = ongoing.id;
    const done = jobs.filter(job => job.status === 'done').reverse(); $('history-count').textContent = done.length; $('total').textContent = `${done.length} conversion(s)`;
    if (done.length) $('results').replaceChildren(...done.map(resultCard));
    const current = jobs.find(job => job.id === activeJob);
    if (current) {
      $('progress').hidden = false; $('log').textContent = current.log || 'Préparation des ressources…';
      $('progress-title').textContent = current.status === 'done' ? 'Conversion terminée' : current.status === 'error' ? 'Conversion interrompue' : 'Conversion en cours';
      $('progress-state').textContent = {done: 'TERMINÉ', error: 'ERREUR', queued: 'PRÉPARATION', running: 'EN COURS'}[current.status];
      if (['done', 'error'].includes(current.status)) { message(current.error || 'Vos packages sont prêts. Ouvrez un aperçu pour tester les animations et télécharger les ZIP.', current.status === 'error'); activeJob = null; $('convert').disabled = false; }
    }
    if (ongoing) $('convert').disabled = true;
  } catch (error) { message(`Connexion interrompue : ${error.message}`, true); }
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
      } catch (error) { message(error.message, true); }
    };
  }
}
