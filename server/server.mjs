import { createServer } from "node:http";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { homedir } from "node:os";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const presentationDirectory = normalize(
  process.env.PRESENTATIONS_DIR || join(homedir(), "Documents", "MyVideoMaker", "presentations"),
);
const distDirectory = join(process.cwd(), "dist");
const maxBodyBytes = 512 * 1024 * 1024;

await mkdir(presentationDirectory, { recursive: true });

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
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new Error("Presentation trop volumineuse");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
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
    sendJson(response, 200, { presentationDirectory });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/presentations") {
    const presentations = await listPresentations();
    presentations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    sendJson(response, 200, { presentationDirectory, presentations });
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
