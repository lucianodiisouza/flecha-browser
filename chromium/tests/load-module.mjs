// Bundle production TypeScript for Node's test runner without adding a test framework.
import { build } from 'esbuild';

let nextInstance = 0;

export async function loadModule(entry, { fresh = false } = {}) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/package.json');" } });
  const instance = fresh ? `#${++nextInstance}` : '';
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}${instance}`);
}
