#!/usr/bin/env node
'use strict';

/**
 * Starts EasyChat (if it is not already running) and puts it on the internet
 * through a Cloudflare quick tunnel. Prints the public link big and clear.
 *
 * Needs cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
 */

require('dotenv').config();

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const children = [];

function serverIsUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/config', timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startServer() {
  console.log('Starting EasyChat server...');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: 'inherit',
    env: process.env,
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const poll = setInterval(async () => {
      if (await serverIsUp()) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error('The server did not come up in time.'));
      }
    }, 400);
  });
}

function startTunnel() {
  const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  let announced = false;
  const watch = (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && !announced) {
      announced = true;
      const url = match[0];
      const line = '─'.repeat(url.length + 8);
      console.log(`\n┌${line}┐`);
      console.log(`│    ${url}    │`);
      console.log(`└${line}┘`);
      console.log('\nShare that link. It stays alive while this command runs.\n');
    }
  };

  child.stdout.on('data', watch);
  child.stderr.on('data', watch);

  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error('\ncloudflared is not installed or not on your PATH.');
      console.error('Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
      console.error(`Then run:   cloudflared tunnel --url http://localhost:${PORT}\n`);
    } else {
      console.error('cloudflared failed:', err.message);
    }
    shutdown(1);
  });

  child.on('exit', (code) => shutdown(code || 0));
}

function shutdown(code) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

(async () => {
  if (!(await serverIsUp())) await startServer();
  else console.log(`Found EasyChat already running on port ${PORT}.`);
  startTunnel();
})().catch((err) => {
  console.error(err.message);
  shutdown(1);
});
