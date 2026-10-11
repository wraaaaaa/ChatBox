import fs from 'node:fs';
import { ROOT } from './config.js';
import path from 'node:path';

export function appInfo() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return {
    name: 'QQ Agent', version: pkg.version, displayVersion: pkg.displayVersion,
    originalAuthor: 'Kondius', maintainer: 'wraaaaaa',
    description: '基于 Kondius 的 QQ Agent 开发，由 wraaaaaa 维护。'
  };
}
