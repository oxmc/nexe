import axios, { AxiosResponse } from "axios";
import { pathExistsAsync } from "../util";
import { LogStep } from "../logger";
import { IncomingMessage } from "http";
import { NexeCompiler, NexeError } from "../compiler";
import { dirname } from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "zlib";
import tar from "tar";
import fs from "fs/promises";

async function downloadWithProgress(
  url: string,
  dest: string,
  options: any = {},
  step?: LogStep
): Promise<void> {
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
    ...options,
  });

  const total = parseInt(response.headers["content-length"] || "0", 10);
  let current = 0;

  // Create write stream
  const writer = createWriteStream(dest);

  // Handle progress
  response.data.on("data", (chunk: Buffer) => {
    current += chunk.length;
    if (step && total > 0) {
      step.modify(`Downloading...${((current / total) * 100).toFixed()}%`);
    }
  });

  // Pipe the response to file
  await pipeline(response.data, writer);

  if (step) {
    step.log(`Download completed: ${dest}`);
  }
}

async function fetchNodeSourceAsync(
  dest: string,
  url: string,
  step: LogStep,
  options = {}
) {
  const setText = (p: number) =>
    step.modify(`Downloading Node: ${p.toFixed()}%...`);

  // Download the file first
  const tempFile = dest + ".tar.gz";
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
    ...options,
  });

  const total = parseInt(response.headers["content-length"] || "0", 10);
  let current = 0;

  // Create write stream for the temp file
  const writer = createWriteStream(tempFile);

  // Track progress
  response.data.on("data", (chunk: Buffer) => {
    current += chunk.length;
    if (total > 0) {
      setText((current / total) * 100);
    }
  });

  // Wait for download to complete
  await pipeline(response.data, writer);

  step.log("Extracting Node...");

  // Extract the tar.gz file
  await pipeline(
    createReadStream(tempFile),
    createGunzip(),
    tar.extract({
      cwd: dest,
      strip: 1,
    })
  );

  // Clean up temp file
  await fs.unlink(tempFile);

  step.log(`Node source extracted to: ${dest}`);
}

async function fetchPrebuiltBinary(compiler: NexeCompiler, step: any) {
  const { target, remoteAsset } = compiler,
    filename = compiler.getNodeExecutableLocation(target);

  try {
    await downloadWithProgress(
      remoteAsset,
      filename,
      compiler.options.downloadOptions,
      step
    );
  } catch (e: any) {
    if (e.response?.status === 404) {
      throw new NexeError(
        `${remoteAsset} is not available, create it using the --build flag`
      );
    } else {
      throw new NexeError("Error downloading prebuilt binary: " + e.message);
    }
  }
}

/**
 * Downloads the node source to the configured temporary directory
 * @param {*} compiler
 * @param {*} next
 */
export default async function downloadNode(
  compiler: NexeCompiler,
  next: () => Promise<void>
) {
  const { src, log, target } = compiler,
    { version } = target,
    { sourceUrl, downloadOptions, build } = compiler.options,
    url =
      sourceUrl ||
      `https://nodejs.org/dist/v${version}/node-v${version}.tar.gz`,
    step = log.step(
      `Downloading ${build ? "" : "pre-built"} Node.js ${
        build ? `source from: ${url}` : ""
      }`
    ),
    exeLocation = compiler.getNodeExecutableLocation(
      build ? undefined : target
    ),
    downloadExists = await pathExistsAsync(build ? src : exeLocation);

  if (downloadExists) {
    step.log("Already downloaded...");
    return next();
  }

  if (build) {
    await fetchNodeSourceAsync(src, url, step, downloadOptions);
  } else {
    await fetchPrebuiltBinary(compiler, step);
  }

  return next();
}

// Helper function to create a readable stream
function createReadStream(path: string) {
  return require("fs").createReadStream(path);
}
