import { NexeCompiler } from '../compiler'

export default async function fsStat(compiler: NexeCompiler, next: () => Promise<void>) {
  await compiler.replaceInFileAsync(
    'lib/fs.js',
    'function statSync(path, options = { bigint: false, throwIfNoEntry: true }) {',
    `function statSync(path, options = { bigint: false, throwIfNoEntry: true }) {
  // If Node passes a file descriptor, we must fstat the REAL fs
  if (typeof path === 'number') {
    try {
      return fstatSync(path, options);
    } catch (e) {
      if (options.throwIfNoEntry) {
        throw e;
      }
      return options.bigint ? BigInt(-1) : -1;
    }
  }
`
  )

  return next()
}
