/**
 * Копирует статику веб-приложения в dist рядом со скомпилированным сервером.
 * tsc переносит только TypeScript, а интерфейсу нужны html, css и js.
 */
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'src', 'ui', 'public');
const to = path.join(root, 'dist', 'ui', 'public');

await mkdir(path.dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
console.log(`статика скопирована: ${path.relative(root, to)}`);
