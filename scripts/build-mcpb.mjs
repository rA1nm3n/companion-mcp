#!/usr/bin/env node
// Builds build/companion-mcp-<version>.mcpb (Claude Desktop extension).
// Steps: stage dist + production dependencies, read the tool list from the real server over stdio,
// render the manifest, validate and pack with the official mcpb CLI.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, 'build', 'mcpb');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, 'build', `companion-mcp-${pkg.version}.mcpb`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

/** Starts the staged server and returns its tools via a real MCP handshake. */
function listTools(entry) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH },
    });
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('tools/list timed out'));
    }, 10000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2 && message.result) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(message.result.tools);
        }
      }
    });
    child.on('error', reject);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'build-mcpb', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

if (!existsSync(join(root, 'dist', 'cli.js'))) throw new Error('dist/ missing: run npm run build');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
for (const file of ['LICENSE', 'README.md', 'package-lock.json']) {
  cpSync(join(root, file), join(stage, file));
}
const { scripts, devDependencies, files, bin, ...rest } = pkg;
void scripts;
void devDependencies;
void files;
void bin;
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(rest, null, 2)}\n`);
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);

const tools = (await listTools(join(stage, 'dist', 'cli.js'))).map(({ name, description }) => ({
  name,
  description: String(description ?? '')
    .split('\n')[0]
    .slice(0, 200),
}));
if (tools.length === 0) throw new Error('server reported no tools');

const template = readFileSync(join(root, 'mcpb', 'manifest.template.json'), 'utf8');
const manifest = JSON.parse(template.replace('__VERSION__', pkg.version));
manifest.tools = tools;
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// Pinned and run through npx on purpose: the CLI is a build-time tool and must not enter the dependency tree.
const mcpb = ['--yes', '@anthropic-ai/mcpb@2.1.2'];
run('npx', [...mcpb, 'validate', join(stage, 'manifest.json')], root);
run('npx', [...mcpb, 'pack', stage, out], root);
console.log(`built ${out} with ${tools.length} tools`);
