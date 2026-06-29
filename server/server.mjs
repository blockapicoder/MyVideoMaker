import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const presentationDirectory = normalize(
  process.env.PRESENTATIONS_DIR || join(homedir(), "Documents", "MyVideoMaker", "presentations"),
);
const exportDirectory = normalize(
  process.env.EXPORTS_DIR || join(homedir(), "Documents", "MyVideoMaker", "videos"),
);
const distDirectory = join(process.cwd(), "dist");
const maxBodyBytes = 512 * 1024 * 1024;
const execFileAsync = promisify(execFile);

await mkdir(presentationDirectory, { recursive: true });
await mkdir(exportDirectory, { recursive: true });

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function presentationFileName(pathname) {
  const prefix = "/api/presentations/";
  if (!pathname.startsWith(prefix)) {
    return "";
  }

  const decoded = decodeURIComponent(pathname.slice(prefix.length));
  if (!decoded.endsWith(".presentation.json") || decoded.includes("/") || decoded.includes("\\")) {
    return "";
  }
  return decoded;
}

async function readRequestBody(request) {
  return (await readRequestBuffer(request)).toString("utf8");
}

async function readRequestBuffer(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new Error("Presentation trop volumineuse");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function safePresentationBaseName(name) {
  const safeName = String(name || "presentation")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 90);
  return safeName || "presentation";
}

function safeExportName(name) {
  return `${safePresentationBaseName(name)}.webm`;
}

function exportFileName(pathname) {
  const prefix = "/api/exports/files/";
  if (!pathname.startsWith(prefix)) {
    return "";
  }

  const decoded = decodeURIComponent(pathname.slice(prefix.length));
  if (!decoded.endsWith(".webm") || decoded.includes("/") || decoded.includes("\\")) {
    return "";
  }
  return decoded;
}

function exportJobParts(pathname) {
  const match = pathname.match(/^\/api\/exports\/([a-f0-9-]+)\/chunks\/(\d+)$/i);
  if (!match) {
    return null;
  }
  return {
    jobId: match[1],
    index: Number(match[2]),
  };
}

async function runFfmpeg(args) {
  await execFileAsync(ffmpegInstaller.path, args, {
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function finishExportJob(jobId, name) {
  const jobDirectory = join(exportDirectory, `.job-${jobId}`);
  const entries = await readdir(jobDirectory);
  const chunkNames = entries
    .filter((entry) => /^chunk-\d+\.webm$/i.test(entry))
    .sort();

  if (chunkNames.length === 0) {
    throw new Error("Aucun morceau video recu");
  }

  const concatFile = join(jobDirectory, "concat.txt");
  const concatContent = chunkNames
    .map((entry) => `file '${join(jobDirectory, entry).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  await writeFile(concatFile, concatContent, "utf8");

  const fileName = safeExportName(name);
  const outputPath = join(exportDirectory, fileName);
  await runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-c",
    "copy",
    outputPath,
  ]);
  const fileStat = await stat(outputPath);
  await rm(jobDirectory, { recursive: true, force: true });
  return {
    fileName,
    outputPath,
    size: fileStat.size,
    updatedAt: fileStat.mtime.toISOString(),
  };
}

async function exportInfoForName(name) {
  const fileName = safeExportName(name);
  const filePath = join(exportDirectory, fileName);

  try {
    const fileStat = await stat(filePath);
    return {
      exists: true,
      fileName,
      outputPath: filePath,
      size: fileStat.size,
      updatedAt: fileStat.mtime.toISOString(),
      url: `/api/exports/files/${encodeURIComponent(fileName)}`,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    return {
      exists: false,
      fileName,
      outputPath: filePath,
      size: 0,
      updatedAt: "",
      url: "",
    };
  }
}

async function listPresentations() {
  const entries = await readdir(presentationDirectory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".presentation.json"));

  return Promise.all(files.map(async (entry) => {
    const filePath = join(presentationDirectory, entry.name);
    const fileStat = await stat(filePath);
    let name = entry.name.replace(/\.presentation\.json$/i, "");

    try {
      const content = JSON.parse(await readFile(filePath, "utf8"));
      if (typeof content.name === "string" && content.name.trim()) {
        name = content.name;
      }
    } catch {
      // Keep the filename as a fallback for malformed legacy files.
    }

    return {
      id: entry.name,
      name,
      size: fileStat.size,
      updatedAt: fileStat.mtime.toISOString(),
    };
  }));
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, { presentationDirectory, exportDirectory });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/exports") {
    const jobId = crypto.randomUUID();
    await mkdir(join(exportDirectory, `.job-${jobId}`), { recursive: true });
    sendJson(response, 200, { jobId });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/exports/latest") {
    sendJson(response, 200, await exportInfoForName(url.searchParams.get("name")));
    return true;
  }

  const exportChunk = exportJobParts(url.pathname);
  if (request.method === "PUT" && exportChunk) {
    const jobDirectory = join(exportDirectory, `.job-${exportChunk.jobId}`);
    await access(jobDirectory);
    const buffer = await readRequestBuffer(request);
    const chunkName = `chunk-${String(exportChunk.index).padStart(5, "0")}.webm`;
    await writeFile(join(jobDirectory, chunkName), buffer);
    sendJson(response, 200, { saved: true, size: buffer.length });
    return true;
  }

  const finishMatch = url.pathname.match(/^\/api\/exports\/([a-f0-9-]+)\/finish$/i);
  if (request.method === "POST" && finishMatch) {
    const rawBody = await readRequestBody(request);
    const payload = rawBody ? JSON.parse(rawBody) : {};
    const result = await finishExportJob(finishMatch[1], payload.name);
    sendJson(response, 200, {
      fileName: result.fileName,
      outputPath: result.outputPath,
      size: result.size,
      updatedAt: result.updatedAt,
      url: `/api/exports/files/${encodeURIComponent(result.fileName)}`,
    });
    return true;
  }

  const fileNameForExport = exportFileName(url.pathname);
  if (request.method === "GET" && fileNameForExport) {
    const content = await readFile(join(exportDirectory, fileNameForExport));
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "video/webm",
    });
    response.end(content);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/presentations") {
    const presentations = await listPresentations();
    presentations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    sendJson(response, 200, { presentationDirectory, exportDirectory, presentations });
    return true;
  }

  const fileName = presentationFileName(url.pathname);
  if (!fileName) {
    return false;
  }

  const filePath = join(presentationDirectory, fileName);
  if (request.method === "GET") {
    try {
      const content = await readFile(filePath, "utf8");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(content);
    } catch (error) {
      if (error?.code === "ENOENT") {
        sendJson(response, 404, { error: "Presentation introuvable" });
      } else {
        throw error;
      }
    }
    return true;
  }

  if (request.method === "PUT") {
    const rawBody = await readRequestBody(request);
    const presentation = JSON.parse(rawBody);
    if (presentation?.app !== "presentation-video-generator" || !Array.isArray(presentation.pages)) {
      sendJson(response, 400, { error: "Format de presentation invalide" });
      return true;
    }
    await writeFile(filePath, JSON.stringify(presentation, null, 2), "utf8");
    sendJson(response, 200, { id: fileName, saved: true });
    return true;
  }

  if (request.method === "DELETE") {
    try {
      await rm(filePath);
      sendJson(response, 200, { deleted: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        sendJson(response, 404, { error: "Presentation introuvable" });
      } else {
        throw error;
      }
    }
    return true;
  }

  sendJson(response, 405, { error: "Methode non autorisee" });
  return true;
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

async function serveFrontend(response, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = join(distDirectory, relativePath);

  try {
    await access(filePath);
  } catch {
    filePath = join(distDirectory, "index.html");
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "Frontend introuvable. Lancez npm run build." });
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, url);
      if (!handled) {
        sendJson(response, 404, { error: "Route API introuvable" });
      }
      return;
    }
    await serveFrontend(response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Erreur serveur" });
  }
});

server.listen(port, host, () => {
  console.log(`API MyVideoMaker: http://${host}:${port}`);
  console.log(`Presentations: ${presentationDirectory}`);
});
