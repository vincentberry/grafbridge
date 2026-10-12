(() => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const original = document.getElementById('results').innerHTML;
  const fixture = {
    id: 'ui-regression', preview: '/build/jobs/ui-regression/index.html',
    report: {templates:[{name:'Example', bytes:1024, warnings:[{type:'source-absente', detail:'Example warning'}], fontLicenses:[]}]}
  };
  document.querySelector('[data-view="history"]').click();
  assert(!document.getElementById('history-view').hidden && document.getElementById('conversion-view').hidden, 'History navigation failed');
  renderHistory([fixture]);
  const panel = document.querySelector('#results details');
  panel.open = true;
  for (let i=0; i<3; i++) renderHistory([JSON.parse(JSON.stringify(fixture))]);
  assert(document.querySelector('#results details') === panel && panel.open, 'Polling closed the warning panel');
  document.querySelector('[data-view="conversion"]').click();
  assert(!document.getElementById('conversion-view').hidden && document.getElementById('history-view').hidden, 'Conversion navigation failed');
  assert(!document.querySelector('.steps'), 'The removed step strip is still present');
  document.getElementById('results').innerHTML = original;
  historySignature = '';
  return true;
})()
