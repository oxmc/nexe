const fs = require("fs"),
  fd = fs.openSync(process.execPath, "r"),
  stat = fs.fstatSync(fd),
  tailSize = Math.min(stat.size, 16000),
  tailWindow = Buffer.alloc(tailSize),
  match = "<nexe" + "~~sentinel>",
  matchLength = match.length,
  lastBuffer = Buffer.alloc(matchLength + 32);

let offset = stat.size,
  footerPosition = -1,
  footerPositionOffset = 0,
  footer: Buffer;

while (true) {
  const bytesRead = fs.readSync(fd, tailWindow, 0, tailSize, offset - tailSize);
  if (bytesRead === 0) break;

  const combinedBuffers = Buffer.concat([tailWindow, lastBuffer]);
  footerPosition = combinedBuffers.indexOf(match);

  if (footerPosition > -1) {
    footer = combinedBuffers.slice(footerPosition, footerPosition + 32);
    break;
  }

  if (offset < 0) break;

  tailWindow.copy(lastBuffer);
  offset = offset - bytesRead;
}

if (footerPosition == -1) {
  throw "Invalid Nexe binary";
}

const contentSize = footer!.readDoubleLE(16),
  resourceSize = footer!.readDoubleLE(24),
  contentStart =
    offset - tailSize + footerPosition - resourceSize - contentSize,
  resourceStart = contentStart + contentSize;

Object.defineProperty(
  process,
  "__nexe",
  (function () {
    let nexeHeader: any = null;
    return {
      get: function () {
        return nexeHeader;
      },
      set: function (value: any) {
        if (nexeHeader) {
          throw new Error("This property is readonly");
        }
        nexeHeader = Object.assign({}, value, {
          blobPath: process.execPath,
          layout: {
            stat,
            contentSize,
            contentStart,
            resourceSize,
            resourceStart,
          },
        });
        Object.freeze(nexeHeader);
      },
      enumerable: false,
      configurable: false,
    };
  })()
);

const contentBuffer = Buffer.alloc(contentSize),
  Module = require("module");

fs.readSync(fd, contentBuffer, 0, contentSize, contentStart);
fs.closeSync(fd);

// Node 24 changed finalizeResolution in the ESM loader to no longer catch ENOENT
// from realpathSync. VFS paths don't exist on real FS, so binding.lstat (called
// internally by realpathSync) throws ENOENT and crashes ESM imports.
// The ESM resolver captures realpathSync via destructuring at load time, so
// patchFs (which runs later) doesn't reach it. We install an ENOENT-tolerant
// wrapper here, before any ESM code can load, so the resolver captures our version.
{
  const _origRpSync: any = fs.realpathSync;
  const nexeRpSync = function(p: string, opts?: any): string {
    try { return _origRpSync(p, opts); }
    catch (e: any) { if (e?.code === 'ENOENT') return p; throw e; }
  };
  (nexeRpSync as any).native = _origRpSync.native;
  (fs as any).realpathSync = nexeRpSync;
}

new Module(process.execPath, null)._compile(
  contentBuffer.slice(1).toString(),
  process.execPath
);
