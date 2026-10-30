const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const ts = require('typescript')

/** Scoped TypeScript loader: tests neither boot Electron nor touch the real user's storage. */
exports.loadBackend = function loadBackend(overrides = {}) {
  const cache = new Map()
  function load(filename) {
    filename = path.resolve(filename)
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    const nativeRequire = createRequire(filename)
    const scopedRequire = (name) => {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      if (name.startsWith('.')) {
        const candidate = path.resolve(path.dirname(filename), name)
        if (fs.existsSync(`${candidate}.ts`)) return load(`${candidate}.ts`)
      }
      return nativeRequire(name)
    }
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText
    new Function('require', 'module', 'exports', '__filename', '__dirname', source)(scopedRequire, module, module.exports, filename, path.dirname(filename))
    return module.exports
  }
  return load
}
