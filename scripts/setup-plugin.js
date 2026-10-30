import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function getTargetArgument() {
    const [target, ...extra] = process.argv.slice(2);
    if (!target || extra.length) {
        throw new Error('Usage: npm run setup:plugin -- /path/to/SillyTavern');
    }
    return target;
}

async function resolveServerRoot(target) {
    const root = await realpath(resolve(target));
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (metadata.name !== 'sillytavern') {
        throw new Error(`${root} is not a SillyTavern installation.`);
    }
    return root;
}

async function inspectDestination(destination) {
    try {
        return await lstat(destination);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

async function resolveLinkTarget(destination) {
    try {
        return await realpath(destination);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

async function validateDestination(source, destination) {
    const existing = await inspectDestination(destination);
    if (!existing) {
        return;
    }
    const refusal = `Refusing to overwrite ${destination}. Remove or relocate it manually first.`;
    if (!existing.isSymbolicLink()) {
        throw new Error(refusal);
    }
    const target = await resolveLinkTarget(destination);
    if (target !== source) {
        throw new Error(refusal);
    }
    return existing;
}

function installDependencies() {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['ci', '--omit=dev', '--ignore-scripts'], { cwd: repository, stdio: 'inherit' });
    if (result.error || result.status !== 0) {
        throw new Error('Dependency installation failed; the plugin link was not changed.', { cause: result.error });
    }
}

async function ensurePluginLink(source, destination) {
    const existing = await validateDestination(source, destination);
    if (existing) {
        return;
    }
    await mkdir(dirname(destination), { recursive: true });
    await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
}

async function installPlugin() {
    const root = await resolveServerRoot(getTargetArgument());
    const source = await realpath(join(repository, 'plugin'));
    const destination = join(root, 'plugins', 'multiplayer');
    await validateDestination(source, destination);
    installDependencies();
    await ensurePluginLink(source, destination);
    console.log(`Plugin installed: ${destination} -> ${source}`);
    console.log('Keep this repository in place. Set enableServerPlugins: true in SillyTavern config.yaml, then restart SillyTavern.');
}

try {
    await installPlugin();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
