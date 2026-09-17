const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createWorker } = require('./helpers/chrome.cjs');
const policy = require('../src/site-policy.js');
const root = path.join(__dirname, '..');
function report(worker) {
  worker.message({ type: 'arch-report-download-context', context: {
    source: 'heritage', agency: '기관', year: '2026', reportTitle: '보고서 제목',
    pageUrl: 'https://www.heritage.go.kr/detail', downloadUrl: 'https://www.heritage.go.kr/download.pdf',
    originalFilename: 'download.pdf', capturedAt: Date.now()
  } }, { tab: { id: 11 }, frameId: 0 });
}
for (const url of [
  'https://history.seoul.go.kr/files/download.pdf',
  'blob:https://www.riss.kr/a-guid',
  'blob:https://www-riss-kr-ssl.proxy.any-school.edu/a-guid',
  'https://library.any-school.edu/route?url=https%3A%2F%2Fwww.kci.go.kr%2Fkciportal%2Farticle',
  'https://unknown-journal.proxy.other-school.edu/download.pdf',
  'https://example.org/download.pdf'
]) test(`does not rename another site's download: ${url}`, async t => {
  const worker = createWorker(root); t.after(() => worker.dispose()); report(worker);
  const results = await worker.download({ id: 1, url, finalUrl: url, filename: 'download.pdf', mime: 'application/pdf' });
  assert.ok(results.every(value => !value));
  assert.equal(worker.external.length, 0);
});
test('report download still renames and duplicate suffix is not blamed on an extension', async t => {
  const worker = createWorker(root); t.after(() => worker.dispose()); report(worker);
  const url = 'https://www.heritage.go.kr/download.pdf';
  const [result] = await worker.download({ id: 2, url, finalUrl: url, filename: 'download.pdf' });
  assert.equal(result.filename, '기관, 2026, 보고서 제목.pdf');
  worker.chrome.downloads.onChanged.listeners.forEach(fn => fn({ id: 2, filename: { current: 'C:\\Downloads\\기관, 2026, 보고서 제목 (1).pdf' } }));
  assert.equal(worker.warnings.length, 0); assert.ok(!worker.badges.includes('!'));
});
test('disabled worker has no filename or external-message handler', async t => {
  const worker = createWorker(root, { data: { archReportSettings: { enabled: false } } }); t.after(() => worker.dispose()); report(worker);
  assert.equal(worker.chrome.downloads.onDeterminingFilename.listeners.length, 0);
  assert.equal(worker.chrome.runtime.onMessageExternal.listeners.length, 0);
});
test('report scope follows blob, wrapped URLs and university proxies', () => {
  for (const url of ['blob:https://www.e-minwon.go.kr/id', 'https://e-minwon-go-kr-ssl.proxy.any.edu/file',
    'https://proxy.other.edu/route?url=https%3A%2F%2Fportal.nrich.go.kr%2Ffile']) {
    assert.equal(policy.isReportSite(url), true, url); assert.equal(policy.isAcademicSite(url), false, url);
  }
});
