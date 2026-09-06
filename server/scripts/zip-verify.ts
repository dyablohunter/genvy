/**
 * Build a zip from a directory with the server's own writer, so it can be
 * checked against a real extractor (Windows Explorer / Expand-Archive).
 *
 *   npx tsx scripts/zip-verify.ts <sourceDir> <outFile.zip>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createZip } from '../src/services/zip.js';

async function main() {
  const [, , srcDir, outFile] = process.argv;
  if (!srcDir || !outFile) {
    console.error('usage: tsx scripts/zip-verify.ts <sourceDir> <outFile.zip>');
    process.exit(1);
  }
  const names = fs.readdirSync(srcDir).filter((n) => !n.endsWith('.zip'));
  const entries = names.map((n) => ({ name: n, data: fs.readFileSync(path.join(srcDir, n)) }));
  const zip = await createZip(entries);
  fs.writeFileSync(outFile, zip);
  console.log(`wrote ${outFile} (${zip.length} bytes) from ${names.length} files`);
}

void main();
