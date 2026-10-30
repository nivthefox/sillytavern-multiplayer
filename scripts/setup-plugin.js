import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function installPlugin() {
    const [target, ...extra] = process.argv.slice(2);
    if (!target || extra.length) {
        throw new Error('Usage: npm run setup:plugin -- /path/to/SillyTavern');
    }
    const root = await realpath(resolve(target));
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (metadata.name !== 'sillytavern') {
        throw new Error(`${root} is not a SillyTavern installation.`);
    }
    const source = await realpath(join(repository, 'plugin'));
    const destination = join(root, 'plugins', 'multiplayer');
    const existing = await lstat(destination).catch(error => {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        return null;
    });
    if (existing && (!existing.isSymbolicLink() || await realpath(destination).catch(() => null) !== source)) {
        throw new Error(`Refusing to overwrite ${destination}. Remove or relocate it manually first.`);
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['ci', '--omit=dev', '--ignore-scripts'], { cwd: repository, stdio: 'inherit' });
    if (result.error || result.status !== 0) {
        throw new Error('Dependency installation failed; the plugin link was not changed.', { cause: result.error });
    }
    await mkdir(dirname(destination), { recursive: true });
    if (!existing) {
        await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
    }
    console.log(`Plugin installed: ${destination} -> ${source}`);
    console.log('Keep this repository in place. Set enableServerPlugins: true in SillyTavern config.yaml, then restart SillyTavern.');
}

try {
    await installPlugin();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
