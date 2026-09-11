const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const roots = ['docs', 'app/src/main/assets/www'].map(dir => path.join(__dirname, '..', dir));
for (const file of ['index.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png']) {
    assert.deepEqual(fs.readFileSync(path.join(roots[0], file)), fs.readFileSync(path.join(roots[1], file)),
        `${file} must match in the website and Android assets`);
}

for (const root of roots) {
    const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    assert.ok(manifest.name || manifest.short_name);
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.scope, './');
    for (const size of [192, 512]) {
        const icon = manifest.icons.find(icon => icon.type === 'image/png' && icon.sizes === `${size}x${size}`
            && (icon.purpose || 'any').split(' ').includes('any'));
        assert.ok(icon, `missing ${size}px install icon in ${root}`);
        const png = fs.readFileSync(path.join(root, icon.src));
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.toString('ascii', 12, 16), 'IHDR');
        assert.equal(png.readUInt32BE(16), size);
        assert.equal(png.readUInt32BE(20), size);
    }
    const touchIcon = page.match(/<link\b[^>]*rel="apple-touch-icon"[^>]*href="([^"]+)"/);
    assert.ok(touchIcon, 'missing Apple touch icon');
    assert.equal(touchIcon[1], 'icon-192.png');
    assert.ok(fs.existsSync(path.join(root, touchIcon[1])));

    const listeners = {}, fetched = [];
    const networkResponse = Promise.resolve({ status: 200 });
    vm.runInNewContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), {
        self: { addEventListener: (type, handler) => { listeners[type] = handler; } },
        fetch: request => { fetched.push(request); return networkResponse; }
    });
    assert.equal(typeof listeners.fetch, 'function', 'older Chromium requires a fetch handler');
    const navigation = { mode: 'navigate', method: 'GET', url: 'https://example.test/math-reader-boox/' };
    let response;
    listeners.fetch({ request: navigation, respondWith: value => { response = value; } });
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0], navigation, 'navigation must forward the original request');
    assert.equal(response, networkResponse, 'navigation must return the original network response');

    for (const [mode, method, url] of [
        ['same-origin', 'GET', 'https://example.test/math-reader-boox/pdf.min.js'],
        ['cors', 'GET', 'https://storage.example.test/metadata.json'],
        ['cors', 'POST', 'https://api.example.test/messages'],
        ['cors', 'PUT', 'https://storage.example.test/document.pdf'],
        ['cors', 'DELETE', 'https://storage.example.test/document.pdf'],
        ['no-cors', 'GET', 'https://cdn.example.test/icon.png']
    ]) {
        listeners.fetch({ request: { mode, method, url }, respondWith() {
            assert.fail(`non-navigation request intercepted: ${method} ${url}`);
        } });
    }
    assert.equal(fetched.length, 1, 'non-navigation requests must use the browser network path');
}

console.log('PWA install icons and navigation-only service worker checks passed');
