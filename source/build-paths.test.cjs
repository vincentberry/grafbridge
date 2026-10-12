const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { BUILD_ROOT, buildPath, temporaryBuildDirectory } = require('./build-paths.cjs');

test('les sorties restent sous build, quel que soit le répertoire courant', () => {
    const previous = process.cwd();
    try {
        process.chdir(path.parse(previous).root);
        assert.equal(buildPath(undefined, 'validation/local'), path.join(BUILD_ROOT, 'validation/local'));
        assert.throws(() => buildPath(path.join(BUILD_ROOT, '../source')), /sous-dossier/);
        assert.throws(() => buildPath(BUILD_ROOT), /sous-dossier/);
        assert.throws(() => buildPath(`${BUILD_ROOT}-outside`), /sous-dossier/);
    } finally {
        process.chdir(previous);
    }
});

test('les fichiers temporaires sont isolés et les jonctions externes sont refusées', async t => {
    const temporary = await temporaryBuildDirectory('paths-test-');
    try {
        assert.equal(path.dirname(temporary), path.join(BUILD_ROOT, 'tmp'));
        const link = path.join(temporary, 'link');
        try {
            await fs.symlink(path.resolve(__dirname), link, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
            if (process.platform === 'win32' && ['EISDIR', 'ENOTSUP', 'ENOSYS', 'EPERM'].includes(error.code)) {
                t.skip(`Ce volume Windows ne permet pas les jonctions (${error.code}).`);
                return;
            }
            throw error;
        }
        assert.throws(() => buildPath(path.join(link, 'output')), /lien symbolique/);
        await fs.unlink(link);
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
});
